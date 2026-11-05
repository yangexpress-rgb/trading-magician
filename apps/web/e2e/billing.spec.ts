import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Plans and limits (§4.3, §19.8; ADR 0022). The tests start workspaces on the
 * dev plan (SIGNUP_PLAN); each limit is checked against the database in
 * packages/db/test/entitlements.test.ts.
 */

test('shows the plan, what is used against each limit, and the plans on offer', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('billing'));

  const plans = await (await page.request.get('/api/v1/plans')).json();
  expect(plans.plans.map((p: { code: string }) => p.code)).toEqual(['free', 'pro']);
  const before = await (await page.request.get('/api/v1/entitlement')).json();
  expect(before).toMatchObject({
    planCode: 'dev',
    limits: { savedStrategies: 50, realIntegrations: false },
    usage: { savedStrategies: 0, connectedAccounts: 1 },
  });

  const created = await page.request.post('/api/v1/strategies', {
    data: { name: 'Counted' },
    headers: { origin: baseURL! },
  });
  expect(created.status()).toBe(201);

  await page.goto('/settings/billing');
  await expect(page.getByText('You are on the Development plan.')).toBeVisible();
  const usage = page.getByRole('table', { name: 'What you use' });
  await expect(usage.getByRole('row', { name: /Saved strategies/ })).toContainText('150');
  await expect(usage.getByRole('row', { name: /Active trading accounts/ })).toContainText('13');
  const compared = page.getByRole('table', { name: 'Plans compared' });
  await expect(compared.getByRole('row', { name: /Price/ })).toContainText('Free$20 a month');
  await expect(compared.getByRole('row', { name: /Alpaca/ })).toContainText('Not includedIncluded');
  await expect(compared).not.toContainText('Real-money');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.map((v) => v.id)).toEqual([]);
});
