import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The Performance tab (§10, §15.3; ADR 0021). A paper strategy buys DEMO-A as
 * soon as it starts; stopping it with its positions closed ends the cycle.
 * Started and stopped twice, it makes two trades, and the tab's figures must
 * match a hand calculation from its filled orders.
 */

const comparison = (id: string, instrumentId: string, operator: 'gt' | 'lt') => ({
  kind: 'comparison',
  id,
  operator,
  left: { kind: 'market', id: `${id}-px`, ...series(instrumentId), interval: '1h' },
  right: { kind: 'constant', id: `${id}-k`, value: '1' },
});

interface Trade {
  closedAt: string | null;
  net: string;
  legs: { symbol: string }[];
}

async function trades(page: Page, strategyId: string): Promise<Trade[]> {
  const res = await page.request.get(`/api/v1/performance/trades?strategyId=${strategyId}`);
  return (await res.json()).trades;
}

test('shows a paper strategy’s cycles, figures and data quality', async ({ page, baseURL }) => {
  test.setTimeout(360_000);
  await signUpAndVerify(page, uniqueEmail('performance'));
  const headers = { origin: baseURL! };

  await page.goto('/performance');
  await expect(page.getByRole('heading', { name: 'Nothing to measure yet' })).toBeVisible();

  const cycler = await createStrategyWithRules(page, baseURL!, 'Cycler', (ids, account) => {
    const a = ids['DEMO-A']!;
    return {
      entry: {
        condition: group('eg', comparison('in', a, 'gt')),
        trigger: { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 },
        orders: [leg('buy', 'Buy A', a, account, 'buy')],
      },
      exit: {
        condition: group('xg', comparison('out', a, 'lt')),
        trigger: { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 },
        orders: [leg('sell', 'Sell A', a, account, 'close')],
      },
    };
  });
  const start = async () => {
    const detail = await (await page.request.get(`/api/v1/strategies/${cycler.id}`)).json();
    const validation = await (
      await page.request.post(`/api/v1/strategies/${cycler.id}/validate`, { headers })
    ).json();
    expect(validation.errors).toEqual([]);
    const res = await page.request.post(`/api/v1/strategies/${cycler.id}/start`, {
      headers,
      data: {
        rowVersion: detail.rowVersion,
        mode: 'paper',
        confirmed: true,
        acknowledgedWarnings: [
          ...new Set(validation.warnings.map((w: { code: string }) => w.code)),
        ],
      },
    });
    expect(res.status()).toBe(200);
  };
  const stopAndClose = async () => {
    const detail = await (await page.request.get(`/api/v1/strategies/${cycler.id}`)).json();
    const res = await page.request.post(`/api/v1/strategies/${cycler.id}/stop`, {
      headers,
      data: { rowVersion: detail.rowVersion, cancelOpenOrders: true, closePositions: true },
    });
    expect(res.status()).toBe(200);
  };
  for (const cycles of [1, 2]) {
    await start();
    // The Entry fills, then stopping closes the position and with it the cycle.
    await expect
      .poll(async () => (await trades(page, cycler.id)).length, { timeout: 30_000 })
      .toBe(cycles);
    await expect
      .poll(
        async () =>
          (await page.request.get('/api/v1/positions').then((r) => r.json())).positions.length,
        {
          timeout: 30_000,
        },
      )
      .toBe(1);
    await stopAndClose();
    await expect
      .poll(async () => (await trades(page, cycler.id)).filter((t) => t.closedAt).length, {
        timeout: 30_000,
      })
      .toBe(cycles);
  }

  // By hand: what the sales brought in less what the purchases cost (paper has no fees).
  const orders = (
    await (await page.request.get(`/api/v1/orders?strategyId=${cycler.id}&limit=500`)).json()
  ).orders as { side: string; filledQuantity: string; averagePrice: string | null }[];
  const expected = orders.reduce((sum, o) => {
    const value = Number(o.filledQuantity) * Number(o.averagePrice ?? 0);
    return o.side === 'buy' ? sum - value : sum + value;
  }, 0);
  const final = await trades(page, cycler.id);
  expect(final).toHaveLength(2);
  expect(Math.abs(final.reduce((s, t) => s + Number(t.net), 0) - expected)).toBeLessThan(0.01);

  // The valuation catches up (every 10 seconds in tests) and the account agrees.
  let summary: {
    pnl: { net: string; realized: string; unrealized: string };
    equity: { end: string | null };
    trades: { closed: number };
  } = await (await page.request.get('/api/v1/performance/summary')).json();
  await expect
    .poll(
      async () => {
        summary = await (await page.request.get('/api/v1/performance/summary')).json();
        return Math.abs(Number(summary.pnl.realized) - expected) < 0.01;
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  expect(summary.pnl.unrealized).toBe('0.00');
  expect(summary.trades.closed).toBe(final.length);
  expect(Math.abs(Number(summary.equity.end) - (100_000 + expected))).toBeLessThan(0.01);

  // The tab shows the same figures.
  await page.goto('/performance');
  const tiles = page.getByRole('region', { name: 'Headline figures' });
  const signed = (n: number) =>
    `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
    })}`;
  await expect(
    tiles.getByText(signed(Number(summary.pnl.net)), { exact: true }).first(),
  ).toBeVisible();
  await expect(tiles.getByText(`${final.length} closed, 0 open`)).toBeVisible();
  // The simulator reports no equity, so the figure is the app's own.
  await expect(tiles.getByText("From the app's ledger")).toBeVisible();
  const table = page.getByRole('table', { name: 'Trades' });
  await expect(table.getByRole('row')).toHaveCount(final.length + 1);
  await expect(table.getByText(/^Buy A: long 20 DEMO-A at/).first()).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'Contribution by strategy' })
      .getByRole('row', { name: /Cycler/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Contribution by asset' }).getByRole('row', { name: /DEMO-A/ }),
  ).toBeVisible();
  await expect(
    page.getByText('Charts appear once there are valuations from two or more sessions.'),
  ).toBeVisible();
  await expect(
    page.getByText('The app and the broker agreed at every close in this range.'),
  ).toBeVisible();
  await expect(page.getByText(/This range has 1 session of history/)).toBeVisible();

  // Filters narrow the view and are kept in the address. The asset classes
  // offered are the ones traded, from the instrument store (v1.2 item 10).
  await expect(page.getByLabel('Asset class', { exact: true }).locator('option')).toHaveText([
    'All asset classes',
    'Stocks',
  ]);
  await page.getByLabel('Asset class', { exact: true }).selectOption({ label: 'Stocks' });
  await expect(page).toHaveURL(/class=stock/);
  await expect(
    page.getByRole('table', { name: 'Contribution by asset' }).getByRole('row', { name: /DEMO-A/ }),
  ).toBeVisible();
  await page.goto(page.url().replace('class=stock', 'class=etf'));
  await expect(page.getByText('No trades in this view.')).toBeVisible();
  await page
    .getByLabel('Asset class', { exact: true })
    .selectOption({ label: 'All asset classes' });
  await page.getByLabel('Strategy', { exact: true }).selectOption({ label: 'Cycler' });
  await expect(page).toHaveURL(/strategy=/);
  await expect(tiles.getByText('Return on peak capital')).toBeVisible();
  await page.getByLabel('Mode', { exact: true }).selectOption({ label: 'Live' });
  await expect(
    page.getByText('Live trading is not available yet, so there are no live results.'),
  ).toBeVisible();
  await page.getByLabel('Mode', { exact: true }).selectOption({ label: 'Paper' });
  await expect(table.getByRole('row')).toHaveCount(final.length + 1);

  await expectAccessible(page);

  // The method behind every figure is one link away (§10.2).
  await page.getByRole('link', { name: 'How these figures are calculated' }).click();
  await expect(page.getByRole('heading', { name: 'How performance is calculated' })).toBeVisible();
  await expect(page.getByText('First in, first out', { exact: false })).toBeVisible();
  await expect(page.getByText('equity more than $1.00 apart', { exact: false })).toBeVisible();
  await expectAccessible(page);
});

async function expectAccessible(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}
