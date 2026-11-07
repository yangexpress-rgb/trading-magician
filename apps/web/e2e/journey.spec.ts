import { expect, type Page } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * One person's whole way through the app before launch (§19.8, ADR 0026): sign
 * up, subscribe, save a strategy, back test it, start it on paper, watch an
 * order fill, stop it, and read the result in Performance. Each step is covered
 * in depth by its own spec; this one proves they hold together.
 */

const comparison = (id: string, instrumentId: string, operator: 'gt' | 'lt') => ({
  kind: 'comparison',
  id,
  operator,
  left: { kind: 'market', id: `${id}-px`, ...series(instrumentId), interval: '1h' },
  right: { kind: 'constant', id: `${id}-k`, value: '1' },
});

async function startOnPaper(page: Page, strategyId: string, headers: Record<string, string>) {
  const detail = await (await page.request.get(`/api/v1/strategies/${strategyId}`)).json();
  const validation = await (
    await page.request.post(`/api/v1/strategies/${strategyId}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);
  const res = await page.request.post(`/api/v1/strategies/${strategyId}/start`, {
    headers,
    data: {
      rowVersion: detail.rowVersion,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [...new Set(validation.warnings.map((w: { code: string }) => w.code))],
    },
  });
  expect(res.status()).toBe(200);
}

test('sign up, subscribe, save, back test, trade on paper and see it in Performance', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(360_000);
  const headers = { origin: baseURL! };
  await signUpAndVerify(page, uniqueEmail('journey'));

  // The person is told what the app is, on every page.
  await expect(page.getByText(/Paper trading only: simulated orders/)).toBeVisible();

  // Subscribe to Pro through the stand-in for Stripe.
  await page.goto('/settings/billing');
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page.getByText('You are on the Pro plan.')).toBeVisible();

  // Save a strategy that buys DEMO-A while its price is above a constant.
  const strategy = await createStrategyWithRules(page, baseURL!, 'Journey', (ids, account) => {
    const a = ids['DEMO-A']!;
    return {
      entry: {
        condition: group('eg', comparison('in', a, 'gt')),
        trigger: { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 },
        orders: [leg('buy', 'Buy A', a, account, 'buy')],
      },
      exit: {
        condition: group('xg', comparison('out', a, 'lt')),
        trigger: { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 },
        orders: [leg('sell', 'Sell A', a, account, 'close')],
      },
    };
  });
  await page.goto(`/strategy-lab/${strategy.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Journey' })).toBeVisible();

  // Back test it and wait for the worker to finish the run.
  const queued = await page.request.post(`/api/v1/strategies/${strategy.id}/backtests`, {
    headers,
    data: { from: '2024-01-02', to: '2024-03-28' },
  });
  expect(queued.status()).toBe(202);
  const runId = (await queued.json()).id;
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/v1/backtests/${runId}`)).json()).status,
      { timeout: 120_000 },
    )
    .toBe('completed');

  // Start it on paper; the Entry order fills and shows up in Orders.
  await startOnPaper(page, strategy.id, headers);
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/orders')).json()).orders.filter(
          (o: { state: string }) => o.state === 'filled',
        ).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await page.goto('/orders');
  await expect(page.getByText('Journey').first()).toBeVisible();

  // Stop it with its position closed, which ends the cycle.
  const detail = await (await page.request.get(`/api/v1/strategies/${strategy.id}`)).json();
  const stopped = await page.request.post(`/api/v1/strategies/${strategy.id}/stop`, {
    headers,
    data: { rowVersion: detail.rowVersion, cancelOpenOrders: true, closePositions: true },
  });
  expect(stopped.status()).toBe(200);
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/v1/performance/trades?strategyId=${strategy.id}`)
          ).json()
        ).trades.filter((t: { closedAt: string | null }) => t.closedAt).length,
      { timeout: 60_000 },
    )
    .toBe(1);

  // Performance shows the closed trade.
  await page.goto('/performance');
  await expect(page.getByRole('heading', { name: 'Nothing to measure yet' })).toHaveCount(0);
  await expect(page.getByText('Journey').first()).toBeVisible();
});
