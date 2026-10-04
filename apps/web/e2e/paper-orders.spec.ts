import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Paper execution end to end (§8, §15.2, §19.6). The worker's paper clock is
 * pinned to a regular NYSE session (playwright.config.ts), so orders fill
 * while the test runs; nothing here reloads the page to see them.
 */

const comparison = (id: string, instrumentId: string, operator: 'gt' | 'lt') => ({
  kind: 'comparison',
  id,
  operator,
  left: { kind: 'market', id: `${id}-px`, ...series(instrumentId) },
  right: { kind: 'constant', id: `${id}-k`, value: '1' },
});
const whileTrue = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };

/** Enters at once (price above 1) and never exits (price below 1); Exit would close `symbol`. */
function enterOnly(
  symbol: string,
  entryLegs: (ids: Record<string, string>, account: string) => unknown[],
) {
  return (ids: Record<string, string>, account: string) => {
    const a = ids[symbol]!;
    return {
      entry: {
        condition: group('eg', comparison('in', a, 'gt')),
        trigger: whileTrue,
        orders: entryLegs(ids, account),
      },
      exit: {
        condition: group('xg', comparison('out', a, 'lt')),
        trigger: whileTrue,
        orders: [leg('close', `Close ${symbol}`, a, account, 'close')],
      },
    };
  };
}

async function startFromLab(page: Page, strategyId: string) {
  await page.goto(`/strategy-lab/${strategyId}`);
  const backTest = page.getByRole('region', { name: 'Back Test', exact: true });
  await backTest.getByRole('button', { name: 'Start execution' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start on paper?' });
  await expect(dialog.getByText('Existing positions')).toBeVisible();
  for (const box of await dialog.getByRole('checkbox').all()) await box.check();
  await dialog.getByRole('button', { name: 'Start on paper' }).click();
  await expect(dialog).toBeHidden();
  return backTest;
}

async function startByApi(page: Page, baseURL: string, id: string, rowVersion: number) {
  const headers = { origin: baseURL };
  const validation = await (
    await page.request.post(`/api/v1/strategies/${id}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);
  const res = await page.request.post(`/api/v1/strategies/${id}/start`, {
    headers,
    data: {
      rowVersion,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [...new Set(validation.warnings.map((w: { code: string }) => w.code))],
    },
  });
  expect(res.status()).toBe(200);
}

const orderRow = (page: Page, legLabel: string) =>
  page
    .getByRole('table', { name: 'Orders' })
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: `${legLabel} details` }) });

test('start on paper, watch Entry fill live, read its timeline, cancel, stop and close', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await signUpAndVerify(page, uniqueEmail('orders'));

  await page.goto('/orders');
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();

  // Start from the Strategy Lab, which then points to Orders (§8.1, §15.2).
  const buyer = await createStrategyWithRules(
    page,
    baseURL!,
    'Paper buyer',
    enterOnly('DEMO-A', (ids, account) => [leg('buy-a', 'Buy A', ids['DEMO-A']!, account, 'buy')]),
  );
  const backTest = await startFromLab(page, buyer.id);
  await backTest.getByRole('link', { name: 'Follow its orders in Orders' }).click();
  await expect(page).toHaveURL(/\/orders\?started=/);
  await expect(page.getByRole('listitem', { name: 'Paper buyer, just started' })).toBeVisible();
  await expect(page.getByText('Live updates on')).toBeVisible();

  // The Entry order appears and fills without a reload.
  const buyRow = orderRow(page, 'Buy A');
  await expect(buyRow.getByText('Filled', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(buyRow).toContainText('Paper');
  await expect(buyRow).toContainText('20 / 20');
  const positions = page.getByRole('table', { name: 'Positions' });
  await expect(positions.getByRole('row', { name: /Paper buyer.*DEMO-A.*Long 20/ })).toBeVisible();

  // Its detail drawer shows the source rule and the full event timeline.
  await buyRow.getByRole('button', { name: 'Buy A details' }).click();
  const drawer = page.getByRole('dialog', { name: 'Buy A · DEMO-A' });
  await expect(drawer.getByText('Placed by strategy', { exact: false })).toBeVisible();
  const rule = drawer.getByRole('region', { name: 'Source rule' });
  await expect(rule.getByText('Buy 20 DEMO-A', { exact: false })).toBeVisible();
  const timeline = drawer.getByRole('region', { name: 'Timeline' });
  for (const step of ['Risk check passed', 'Sent to the paper broker', 'Accepted by the broker']) {
    await expect(timeline.getByText(step)).toBeVisible();
  }
  await expect(timeline.getByText(/^Filled 20 at /)).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close details' }).click();
  await expect(drawer).toBeHidden();

  // A resting limit order shows up as working and can be canceled by hand (§14.3).
  const bid = await createStrategyWithRules(page, baseURL!, 'Resting bid', (ids, account) => ({
    ...enterOnly('DEMO-B', () => [
      {
        ...leg('bid-b', 'Low bid', ids['DEMO-B']!, account, 'buy'),
        orderType: 'limit',
        limitPrice: { kind: 'constant', id: 'lp', value: '1' },
        timeInForce: 'gtc',
      },
    ])(ids, account),
  }));
  // The far-away limit needs a wide price collar to pass the risk check.
  const detail = await (await page.request.get(`/api/v1/strategies/${bid.id}`)).json();
  const widened = await page.request.patch(`/api/v1/strategies/${bid.id}`, {
    headers: { origin: baseURL! },
    data: {
      rowVersion: detail.rowVersion,
      definition: {
        ...detail.definition,
        risk: { ...detail.definition.risk, priceCollarPct: '100' },
      },
    },
  });
  expect(widened.status()).toBe(200);
  const { rowVersion } = await widened.json();
  // Back on Orders before it starts, so the new order arrives live.
  await page.goto('/orders');
  await expect(page.getByText('Live updates on')).toBeVisible();
  await startByApi(page, baseURL!, bid.id, rowVersion);

  const bidRow = orderRow(page, 'Low bid');
  await expect(bidRow.getByText('Working', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Working/ }).click();
  await expect(orderRow(page, 'Buy A')).toHaveCount(0);
  await bidRow.getByRole('button', { name: 'Low bid details' }).click();
  const bidDrawer = page.getByRole('dialog', { name: 'Low bid · DEMO-B' });
  await bidDrawer.getByRole('button', { name: 'Cancel order' }).click();
  await bidDrawer.getByRole('button', { name: 'Yes, cancel order' }).click();
  await expect(bidDrawer.getByText('Canceled', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(bidDrawer.getByRole('region', { name: 'Timeline' })).toContainText(
    'Cancel requested (Canceled by you)',
  );
  await bidDrawer.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: /^All/ }).click();

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);

  // Stopping offers closing as a separate choice; the close is the person's order.
  await page.goto(`/strategy-lab/${buyer.id}`);
  await page
    .getByRole('region', { name: 'Back Test', exact: true })
    .getByRole('button', { name: 'Stop execution' })
    .click();
  const stop = page.getByRole('dialog', { name: 'Stop execution?' });
  await stop.getByLabel("Close this strategy's positions with market orders").check();
  await stop.getByRole('button', { name: 'Stop execution' }).click();
  await expect(page.getByText('Status: Off')).toBeVisible();

  await page.goto(`/orders?strategy=${buyer.id}`);
  const closeRow = orderRow(page, 'Close DEMO-A');
  await expect(closeRow).toContainText('(you)');
  await expect(closeRow.getByText('Filled', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('row', { name: /Paper buyer.*DEMO-A.*Long 20/ })).toHaveCount(0);
});
