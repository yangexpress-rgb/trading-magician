import { expect, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The Library edit form opens with the entry's stored parameters and never
 * drops them on save (S00005-SD, observed on staging 2026-11-08).
 */
const legend = (page: Page) => page.locator('legend', { hasText: /^Parameters \(/ });

test('the edit form loads stored parameters and saving keeps them', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('library-params'));
  await page.goto('/library/S00005-SD/edit');
  await expect(legend(page)).toHaveText('Parameters (2/10)');
  await expect(page.locator('#lib-param-0-name')).toHaveValue('Entry channel');
  await expect(page.locator('#lib-param-0-value')).toHaveValue('20');
  await expect(page.locator('#lib-param-0-unit')).toHaveValue('days');
  await expect(page.locator('#lib-param-1-name')).toHaveValue('Exit channel');
  await expect(page.locator('#lib-param-1-value')).toHaveValue('10');
  await expect(page.locator('#lib-param-1-unit')).toHaveValue('days');

  // An unrelated edit keeps both parameters and does not list them as changed.
  const long = page.getByLabel('Long description');
  await long.fill(`${await long.inputValue()} Checked.`);
  await page.getByLabel('Change note').fill('Longer description');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(/\/library\/S00005-SD$/);
  await expect(page.getByRole('cell', { name: 'Entry channel' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Exit channel' })).toBeVisible();
  const history = page.getByText('“Longer description”').first().locator('..');
  await expect(history).not.toContainText('Parameters');
  await expect(history).toContainText('Changed: Long description');

  // A third parameter saves and loads back with the other two.
  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(legend(page)).toHaveText('Parameters (2/10)');
  await page.getByRole('button', { name: 'Add a parameter' }).click();
  await page.locator('#lib-param-2-name').fill('Test parameter');
  await page.locator('#lib-param-2-value').fill('1');
  await page.getByLabel('Change note').fill('Third parameter');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(/\/library\/S00005-SD$/);
  await expect(page.getByRole('cell', { name: 'Test parameter' })).toBeVisible();
  await page.reload();
  await page.getByRole('link', { name: 'Edit' }).click();
  await expect(legend(page)).toHaveText('Parameters (3/10)');
  await expect(page.locator('#lib-param-2-name')).toHaveValue('Test parameter');

  // Removing it on purpose is allowed; the entry is left with its two.
  await page
    .locator('#lib-param-2-name')
    .locator('xpath=ancestor::div[contains(@class, "grid-cols-1")][1]')
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(legend(page)).toHaveText('Parameters (2/10)');
  await page.getByLabel('Change note').fill('Remove the test parameter');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(/\/library\/S00005-SD$/);
  await expect(page.getByRole('cell', { name: 'Test parameter' })).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'Entry channel' })).toBeVisible();
});
