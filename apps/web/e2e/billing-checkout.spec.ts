import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Subscribing and its changes (§4.3, §19.8; ADR 0023), through the in-process
 * stand-in for Stripe: its pages send the signed webhooks Stripe would, and
 * the app applies them through its real webhook endpoint.
 */

test('subscribes, survives replayed and failed payments, cancels and is held to Free', async ({
  page,
  baseURL,
  playwright,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  const forged = await anonymous.post('/api/v1/webhooks/billing', {
    data: { id: 'evt_forged', type: 'customer.subscription.updated' },
  });
  expect(forged.status()).toBe(400);
  await anonymous.dispose();

  await signUpAndVerify(page, uniqueEmail('subscribe'));
  await page.goto('/settings/billing');
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await expect(page.getByRole('heading', { name: 'Test checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay' }).click();

  await expect(page).toHaveURL(/\/settings\/billing\?checkout=done$/);
  await expect(page.getByText('You are on the Pro plan.')).toBeVisible();
  await expect(page.getByText(/Your Pro plan renews on/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toHaveCount(0);

  const billingNotes = async () =>
    (await (await page.request.get('/api/v1/notifications?limit=200')).json()).notifications.filter(
      (n: { kind: string }) => n.kind === 'billing',
    );
  expect((await billingNotes()).map((n: { title: string }) => n.title)).toEqual([
    'You are now on the Pro plan',
  ]);

  const portal = async (action: string) => {
    await page.goto('/settings/billing');
    await page.getByRole('button', { name: 'Manage billing' }).click();
    await expect(page.getByRole('heading', { name: 'Test billing portal' })).toBeVisible();
    await page.getByRole('button', { name: action }).click();
    await expect(page.getByRole('main').getByRole('status')).toContainText('Done');
    await page.getByRole('link', { name: 'Back to Trading Magician' }).click();
    await expect(page).toHaveURL(/\/settings\/billing$/);
  };

  // Every event again: nothing changes twice (§19.8).
  await portal('Send every event again');
  await expect(page.getByText('You are on the Pro plan.')).toBeVisible();
  expect(await billingNotes()).toHaveLength(1);

  await portal('Make the next payment fail');
  const failed = page
    .getByRole('main')
    .getByText(
      /Your last payment failed\. Update your card in Manage billing by .+ to keep your Pro plan/,
    );
  await expect(failed).toBeVisible();
  await portal('Pay the overdue invoice');
  await expect(failed).toHaveCount(0);

  await portal('Cancel at the end of the period');
  await expect(
    page.getByText(/Your Pro plan ends on .*, and you move to Free then\./),
  ).toBeVisible();
  await portal('End the billing period now');
  await expect(page.getByText('You are on the Free plan.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upgrade to Pro' })).toBeVisible();

  // Free keeps 3 strategies; the fourth is refused by the server.
  const headers = { origin: baseURL! };
  for (const name of ['One', 'Two', 'Three']) {
    expect(
      (await page.request.post('/api/v1/strategies', { data: { name }, headers })).status(),
    ).toBe(201);
  }
  const fourth = await page.request.post('/api/v1/strategies', { data: { name: 'Four' }, headers });
  expect(fourth.status()).toBe(403);
  expect((await fourth.json()).error).toMatchObject({
    code: 'plan_limit',
    details: { limit: 'savedStrategies', planCode: 'free', allowed: 3, used: 3 },
  });
});
