import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Stored API keys (§9.2, §16.1, §19.7): a saved key is encrypted at once and
 * never comes back to the browser, only its masked end.
 */

const KEY_ID = 'PKE2ETESTKEY0000K9Z1';
const SECRET = 'e2e-secret-value-should-never-return-W7Q4';

test('saves an API key write-only, replaces it and removes it', async ({ page, baseURL }) => {
  await signUpAndVerify(page, uniqueEmail('keys'));
  await page.goto('/settings/security');
  const panel = page.getByRole('region', { name: 'Stored API keys' });
  await expect(panel.getByText('No stored keys yet.')).toBeVisible();

  await panel.getByRole('button', { name: 'Add an API key' }).click();
  const add = page.getByRole('dialog', { name: 'Add an API key' });
  await add.getByLabel('Name').fill('Alpaca paper');
  const secretInput = add.getByLabel('Secret key');
  await expect(secretInput).toHaveAttribute('type', 'password');
  await expect(secretInput).toHaveAttribute('autocomplete', 'off');
  await add.getByLabel('API key ID').fill(KEY_ID);
  await secretInput.fill(SECRET);
  await add.getByRole('button', { name: 'Save key' }).click();
  await expect(add).toBeHidden();

  const item = panel.getByRole('listitem', { name: 'Alpaca paper' });
  await expect(item).toContainText('API key ID ••••K9Z1');
  await expect(item).toContainText('Secret key ••••W7Q4');
  await expect(item).toContainText('Not used yet');

  // Neither the page nor the API ever carries the value again.
  await page.reload();
  await expect(item).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);
  const listed = await page.request.get('/api/v1/credentials');
  const body = await listed.text();
  expect(body).not.toContain(SECRET);
  expect(body).not.toContain(KEY_ID);

  // Replacing keeps the entry and shows the new masked end.
  await item.getByRole('button', { name: 'Replace key' }).click();
  const replace = page.getByRole('dialog', { name: 'Replace Alpaca paper?' });
  await expect(replace.getByLabel('Secret key')).toHaveValue('');
  await replace.getByLabel('API key ID').fill('PKE2ENEWKEY00000AAA2');
  await replace.getByLabel('Secret key').fill('e2e-second-secret-value-000000BBB3');
  await replace.getByRole('button', { name: 'Replace key' }).click();
  await expect(replace).toBeHidden();
  await expect(item).toContainText('Secret key ••••BBB3');
  await expect(item).toContainText('replaced');

  // A save that skips a field is refused without echoing anything back.
  const partial = await page.request.post('/api/v1/credentials', {
    headers: { origin: baseURL! },
    data: { provider: 'alpaca', label: 'Half', fields: { keyId: KEY_ID } },
  });
  expect(partial.status()).toBe(400);
  expect(await partial.text()).not.toContain(KEY_ID);

  await item.getByRole('button', { name: 'Remove' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove Alpaca paper?' });
  await remove.getByRole('button', { name: 'Remove key' }).click();
  await expect(panel.getByText('No stored keys yet.')).toBeVisible();
});
