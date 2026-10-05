import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/** The performance API's contract (§14.3; ADR 0021). The numbers are checked in M5.4's tab test. */

test('serves performance only to its owner, with validated filters', async ({
  page,
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  for (const path of ['summary', 'timeseries', 'trades']) {
    const res = await anonymous.get(`/api/v1/performance/${path}`);
    expect(res.status()).toBe(401);
  }
  await anonymous.dispose();

  await signUpAndVerify(page, uniqueEmail('perf-api'));
  const summary = await page.request.get('/api/v1/performance/summary');
  expect(summary.status()).toBe(200);
  expect(await summary.json()).toMatchObject({
    currency: 'USD',
    filtered: false,
    trades: { count: 0, winRatePct: null },
    byStrategy: [],
    dataQuality: { differences: [] },
  });
  expect(await (await page.request.get('/api/v1/performance/trades')).json()).toEqual({
    currency: 'USD',
    trades: [],
  });
  const live = await page.request.get('/api/v1/performance/timeseries?mode=live');
  expect(await live.json()).toEqual({ currency: 'USD', filtered: true, points: [] });

  const bad = await page.request.get(
    '/api/v1/performance/summary?from=2026-10-07&to=2026-10-06&assetClass=bonds',
  );
  expect(bad.status()).toBe(400);
  const body = await bad.json();
  expect(body.error.code).toBe('bad_request');
  const several = await page.request.get(
    `/api/v1/performance/summary?accountId=${crypto.randomUUID()}&accountId=${crypto.randomUUID()}&assetClass=etf`,
  );
  expect(several.status()).toBe(200);
  expect((await several.json()).filtered).toBe(true);
});
