import { expect, type APIRequestContext } from '@playwright/test';
import { createTestedStrategy } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The back-test API (§14.2) end to end: the web app queues a run, the worker
 * (started beside the web server) claims and simulates it, and the results,
 * trades and CSV come back.
 */

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
  const created = await createTestedStrategy(page, baseURL!, 'API crossover');

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
