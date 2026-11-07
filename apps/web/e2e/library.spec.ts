import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Strategy Library (ADR 0051) through the browser: the seeded catalogue, the
 * register form's live number preview, edit with a change note, and retire.
 * Numbers after the seed depend on what earlier tests registered, so they are
 * read from the page rather than assumed.
 */
test('lists the seed, registers with a previewed number, edits and retires', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('library'));
  await page.goto('/library');
  await expect(page.getByRole('heading', { level: 1, name: 'Strategy Library' })).toBeVisible();
  const rows = page.getByRole('table', { name: 'Strategy Library entries' }).locator('tbody tr');
  await expect(rows.first()).toContainText('SDS-0001');
  await expect(rows.nth(17)).toContainText('SMA-0018');

  // Filters: options trades only.
  await page.getByLabel('Asset class').selectOption('O');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('3 entries')).toBeVisible();
  await page.getByRole('link', { name: 'Clear' }).click();

  // The seed detail: number, prose, provenance with its evidence level.
  await page.getByRole('link', { name: 'SDS-0005' }).first().click();
  await expect(page.getByText('SDS-0005', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Book', { exact: true })).toBeVisible();
  await expect(page.getByText('Turnaround time (typical holding period)')).toBeVisible();
  await expect(page.getByText('Unknown', { exact: true })).toBeVisible();

  // Register: the preview shows the expected number before saving.
  await page.goto('/library/new');
  await page.getByLabel('Timeframe (decision timescale)').selectOption('W');
  await page.getByLabel('Asset class (what it trades)').selectOption('E');
  const preview = page.getByTestId('number-preview');
  await expect(preview).toContainText(/SWE-\d{4}/);
  const expected = (await preview.locator('.font-mono').textContent())?.trim() ?? '';
  await page.getByLabel('Name').fill('Weekly ETF test entry');
  await page.getByLabel('Category').selectOption('trend');
  await page.getByLabel(/^Short description/).fill('A weekly test entry.');
  await page.getByLabel('Long description').fill('How the **test** works.');
  await page.getByLabel('Assets traded').fill('SPY only');
  await page.getByLabel('Entry', { exact: true }).fill('Buy on Monday.');
  await page.getByLabel('Exit', { exact: true }).fill('Sell on Friday.');
  await page.locator('#lib-frequency-value').fill('1');
  await page.locator('#lib-frequency-unit').selectOption('weeks');
  await page.locator('#lib-turnaround-value').fill('5');
  await page.locator('#lib-turnaround-unit').selectOption('days');
  await page.locator('#lib-turnaround-low').fill('2');
  await page.locator('#lib-turnaround-high').fill('10');
  // A prior user without a source is refused.
  await page.getByRole('button', { name: 'Add a prior user' }).click();
  await page.getByLabel('Who').fill('A fund');
  await page.getByLabel('What they did').fill('Ran it');
  await page.getByLabel('Evidence').selectOption('anecdote');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.locator('#lib-usedby-0-source-error')).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Register' }).click();

  await expect(page).toHaveURL(new RegExp(`/library/${expected}$`));
  await expect(page.getByText('5 days (range 2–10 days)')).toBeVisible();
  await expect(page.getByText('1 week', { exact: true })).toBeVisible();
  await expect(page.getByText('No known prior use recorded.')).toBeVisible();

  // Edit needs a change note and keeps the number.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Name').fill('Weekly ETF test entry, renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#lib-change-note-error')).toBeVisible();
  await page.getByLabel('Change note').fill('Clearer name');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/library/${expected}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Weekly ETF test entry, renamed',
  );
  await expect(page.getByText('“Clearer name”')).toBeVisible();

  // Retire keeps it visible, badged, with its number.
  await page.getByRole('button', { name: 'Retire' }).click();
  await page.getByLabel('Reason').fill('Test finished');
  await page.getByRole('button', { name: 'Retire entry' }).click();
  await expect(page.getByText('Retired', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retire' })).toHaveCount(0);
  await page.goto(`/library?q=${expected}`);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Retired');
});
