import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/** Production operations (ADR 0025): the uptime check and the shared rate limit. */

test('the system health check sees the database and a live worker', async ({
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  await expect
    .poll(async () => (await anonymous.get('/api/health/system')).status(), { timeout: 60_000 })
    .toBe(200);
  const res = await anonymous.get('/api/health/system');
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(await res.json()).toMatchObject({ status: 'ok', database: 'ok', worker: 'ok' });
  await anonymous.dispose();
});

test('limits each person to 120 changes a minute, counted in the database', async ({
  page,
  baseURL,
}) => {
  const headers = { origin: baseURL! };
  await signUpAndVerify(page, uniqueEmail('rate'));
  const statuses: number[] = [];
  for (let i = 0; i < 121; i += 1) {
    const res = await page.request.post('/api/v1/strategies', { data: {}, headers });
    statuses.push(res.status());
  }
  expect(statuses.slice(0, 120)).not.toContain(429);
  expect(statuses[120]).toBe(429);
  const limited = await page.request.post('/api/v1/strategies', { data: {}, headers });
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);
  expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
});
