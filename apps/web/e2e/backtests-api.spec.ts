import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The back-test API (§14.2) end to end: the web app queues a run, the worker
 * (started beside the web server) claims and simulates it, and the results,
 * trades and CSV come back.
 */

/** Instrument ids as the editor lists them, read from a leg's Instrument picker. */
async function instrumentIds(page: Page, strategyId: string) {
  await page.goto(`/strategy-lab/${strategyId}`);
  await page.getByRole('button', { name: '+ Add Entry order' }).click();
  const options = page
    .getByRole('region', { name: 'Entry leg 1', exact: true })
    .getByLabel('Instrument', { exact: true })
    .locator('option');
  const ids: Record<string, string> = {};
  for (const o of await options.all()) {
    const symbol = (await o.textContent())?.split(' ·')[0]?.trim();
    const value = await o.getAttribute('value');
    if (symbol && value) ids[symbol] = value;
  }
  return ids;
}

function crossover(instrumentId: string, accountId: string) {
  const px = {
    instrumentId,
    field: 'close',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    offset: 0,
  };
  const sma = { kind: 'indicator', name: 'SMA', params: { period: 20 }, ...px };
  const leg = {
    instrumentId,
    accountId,
    quantity: { type: 'units', value: '20', rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    extendedHours: false,
    timing: { mode: 'immediate' },
    timingOnly: false,
  };
  const trigger = { mode: 'on_transition', cooldownSec: 0, confirmationBars: 0 };
  return {
    schemaVersion: 1,
    entry: {
      condition: {
        kind: 'group',
        id: 'eg',
        op: 'and',
        negate: false,
        children: [
          {
            kind: 'comparison',
            id: 'in',
            operator: 'crosses_above',
            left: { kind: 'market', id: 'p1', ...px },
            right: { ...sma, id: 's1' },
          },
        ],
      },
      trigger,
      orders: [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }],
    },
    exit: {
      condition: {
        kind: 'group',
        id: 'xg',
        op: 'and',
        negate: false,
        children: [
          {
            kind: 'comparison',
            id: 'out',
            operator: 'crosses_below',
            left: { kind: 'market', id: 'p2', ...px },
            right: { ...sma, id: 's2' },
          },
        ],
      },
      trigger,
      orders: [{ id: 'sell', legLabel: 'Sell A', side: 'close', ...leg }],
    },
  };
}

async function waitForRun(request: APIRequestContext, runId: string) {
  let run: { status: string } = { status: 'queued' };
  await expect
    .poll(
      async () => {
        run = await (await request.get(`/api/v1/backtests/${runId}`)).json();
        return run.status;
      },
      { timeout: 30_000 },
    )
    .toMatch(/completed|failed|canceled/);
  return run;
}

test('queue a back test, let the worker run it, and read the results', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('backtest-api'));
  const headers = { origin: baseURL! };
  const created = await (
    await page.request.post('/api/v1/strategies', { data: { name: 'API crossover' }, headers })
  ).json();
  const ids = await instrumentIds(page, created.id);
  const base = await (await page.request.get(`/api/v1/strategies/${created.id}`)).json();
  const def = {
    ...crossover(ids['DEMO-A']!, created.defaultAccountId),
    execution: base.definition.execution,
    risk: base.definition.risk,
  };
  const saved = await page.request.patch(`/api/v1/strategies/${created.id}`, {
    data: { rowVersion: base.rowVersion, definition: def },
    headers,
  });
  expect(saved.status()).toBe(200);

  // Bad dates are field errors.
  const future = await page.request.post(`/api/v1/strategies/${created.id}/backtests`, {
    data: { from: '2025-01-02', to: '2029-01-02' },
    headers,
  });
  expect(future.status()).toBe(400);
  expect((await future.json()).error.issues[0].path).toEqual(['to']);

  const queued = await page.request.post(`/api/v1/strategies/${created.id}/backtests`, {
    data: { from: '2023-01-03', to: '2023-12-29' },
    headers,
  });
  expect(queued.status()).toBe(202);
  const run = await queued.json();
  expect(run).toMatchObject({ status: 'queued', versionNo: 1, dataSource: 'demo-history' });
  expect(run.inputs).toMatchObject({ interval: '1d', slippageBps: '5', initialCapital: '100000' });

  const done = (await waitForRun(page.request, run.id)) as {
    status: string;
    engineVersion: string;
    metrics: { cycles: number };
    result: { equity: unknown[]; assumptions: string[] };
  };
  expect(done.status).toBe('completed');
  expect(done.engineVersion).toBe('engine@1');
  expect(done.metrics.cycles).toBeGreaterThan(0);
  expect(done.result.equity).toHaveLength(250);

  const { trades } = await (await page.request.get(`/api/v1/backtests/${run.id}/trades`)).json();
  expect(trades).toHaveLength(done.metrics.cycles);
  const csv = await page.request.get(`/api/v1/backtests/${run.id}/export`);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const lines = (await csv.text()).trimEnd().split('\r\n');
  expect(lines[0]).toMatch(/^cycle,status,entry_time/);
  expect(lines.length).toBeGreaterThan(trades.length);

  const list = await (await page.request.get(`/api/v1/strategies/${created.id}/backtests`)).json();
  expect(list.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);

  // Finished runs can't be canceled; other people's runs don't exist.
  const late = await page.request.post(`/api/v1/backtests/${run.id}/cancel`, { headers });
  expect(late.status()).toBe(409);
  const missing = await page.request.get('/api/v1/backtests/00000000-0000-4000-8000-000000000000');
  expect(missing.status()).toBe(404);
  expect((await page.request.get('/api/v1/backtests/not-a-uuid')).status()).toBe(404);
});
