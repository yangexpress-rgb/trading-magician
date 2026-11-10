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
  await expect(page.getByRole('heading', { level: 1, name: 'Theory Library' })).toBeVisible();
  const rows = page.getByRole('table', { name: 'Theory Library entries' }).locator('tbody tr');
  await expect(rows.first()).toContainText('T00001-SD');
  await expect(rows.nth(17)).toContainText('T00018-AM');
  await expect(rows.nth(30)).toContainText('T00031-FS');

  // Clicking a column header sorts by it: ascending, then descending (N168).
  const table = page.getByRole('table', { name: 'Theory Library entries' });
  const numberHeader = table.getByRole('columnheader', { name: /^Number/ });
  await expect(numberHeader).toHaveAttribute('aria-sort', 'ascending');
  await numberHeader.getByRole('link').click();
  await expect(numberHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first()).not.toContainText('T00001-SD');
  await expect(rows.last()).toContainText('T00001-SD');
  await numberHeader.getByRole('link').click();
  await expect(rows.first()).toContainText('T00001-SD');
  const categoryHeader = table.getByRole('columnheader', { name: /^Category/ });
  const categories = () => rows.locator('td:nth-child(6)').allInnerTexts();
  const byText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });
  await categoryHeader.getByRole('link').click();
  await expect(categoryHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(numberHeader).toHaveAttribute('aria-sort', 'none');
  const up = await categories();
  expect(up).toEqual([...up].sort(byText));
  await categoryHeader.getByRole('link').click();
  await expect(categoryHeader).toHaveAttribute('aria-sort', 'descending');
  const down = await categories();
  expect(down).toEqual([...down].sort(byText).reverse());
  await page.goto('/library');

  // Library v2 filters (ADR 0055): one entry needs earnings consensus.
  // Filters are pills that apply at once (N194); Data needs waits in the Filter menu.
  const filters = page.getByRole('toolbar', { name: 'Filter the library' });
  await expect(page.getByRole('button', { name: 'Apply filters' })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('menuitem', { name: 'Data needs' }).click();
  await page.getByRole('radio', { name: /earnings consensus/i }).click();
  await expect(page).toHaveURL(/data=earnings_consensus/);
  await expect(page.getByText('1 entry', { exact: true })).toBeVisible();
  await expect(rows.first()).toContainText('T00026-SD');
  await filters.getByRole('button', { name: /^Clear filters/ }).click();
  await expect(page).toHaveURL(/\/library$/);

  // Filters: options trades only.
  await filters.getByRole('button', { name: /^Asset class/ }).click();
  await page.getByRole('radio', { name: /\(O\)$/ }).click();
  await expect(page.getByText('3 entries')).toBeVisible();
  await filters.getByRole('button', { name: 'Remove the Asset class filter' }).click();
  await expect(page).toHaveURL(/\/library$/);

  // The seed detail: number, prose, provenance with its evidence level.
  // A former number redirects to the current one.
  await page.goto('/library/SDS-0005');
  await expect(page).toHaveURL(/\/library\/T00005-SD$/);
  // So does the S number it had before Library entries became theories (N181).
  await page.goto('/library/S00005-SD');
  await expect(page).toHaveURL(/\/library\/T00005-SD$/);
  await expect(page.getByText('T00005-SD', { exact: true }).first()).toBeVisible();
  // Former numbers resolve but are not shown (Yong, 2026-11-08).
  await expect(page.getByText(/^Formerly /)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Parameters' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Entry channel' })).toBeVisible();
  await expect(page.getByText('Book', { exact: true })).toBeVisible();
  await expect(page.getByText('Turnaround time (typical holding period)')).toBeVisible();
  await expect(page.getByText('Unknown', { exact: true })).toBeVisible();

  // Register: the preview shows the expected number before saving.
  await page.goto('/library/new');
  await page.getByLabel('Timeframe (decision timescale)').selectOption('W');
  await page.getByLabel('Asset class (what it trades)').selectOption('E');
  const preview = page.getByTestId('number-preview');
  await expect(preview).toContainText(/T\d{5}-EW/);
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
  await page.getByLabel('Direction').selectOption('long_only');
  await page.getByRole('button', { name: 'Add a parameter' }).click();
  await page.getByLabel('Parameter 1', { exact: true }).fill('Hold');
  await page.locator('#lib-param-0-value').fill('5');
  await page.locator('#lib-param-0-unit').fill('days');
  await page.getByLabel('Daily bars').check();
  // A prior user without a source is refused.
  await page.getByRole('button', { name: 'Add a prior user' }).click();
  await page.getByLabel('Who').fill('A fund');
  await page.getByLabel('What they did').fill('Ran it');
  await page.getByLabel('Evidence').selectOption('anecdote');
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.locator('#lib-usedby-0-source-error')).toBeVisible();
  await page
    .locator('fieldset', { hasText: 'Prior user 1' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await page.getByRole('button', { name: 'Register' }).click();

  await expect(page).toHaveURL(new RegExp(`/library/${expected}$`));
  await expect(page.getByText('5 days (range 2–10 days)')).toBeVisible();
  await expect(page.getByText('1 week', { exact: true })).toBeVisible();
  await expect(page.getByText('No known prior use recorded.')).toBeVisible();
  await expect(page.getByText('Long only').first()).toBeVisible();
  await expect(page.getByText('Not specified').first()).toBeVisible();

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
