import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The watch list (N292, ADR 0101): groups of symbols with live Last, Chg and
 * Chg%, kept per person. Prices come from the person's Alpaca feed (the fake,
 * in E2E) and the VIX from Cboe's daily history (also a fake).
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

test('follows symbols in groups with prices that update', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('watch-list'));
  await page.goto('/settings/data-feeds');
  await page.getByRole('button', { name: 'Add a feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await add.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await add.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await add.getByLabel('Secret key').fill(FAKE_SECRET);
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();

  await page.goto('/research');
  await page
    .getByRole('navigation', { name: 'Tools' })
    .getByRole('link', { name: 'Watch list' })
    .click();
  await expect(page).toHaveURL(/\/research\/watch-list$/);

  // A new list starts with indices and stocks.
  const table = page.getByRole('table', { name: 'Watch list' });
  const indices = table.getByRole('rowgroup', { name: 'Indices' });
  await expect(indices.getByRole('row', { name: /SPY/ })).toBeVisible();
  await expect(indices.getByRole('row', { name: /VIX/ })).toBeVisible();
  // The VIX is a daily close in points: no $, a D mark.
  const vix = indices.getByRole('row', { name: /VIX/ });
  await expect(vix.getByLabel('daily close')).toBeVisible({ timeout: 20_000 });
  await expect(vix.getByRole('cell').nth(1)).toHaveText(/^\d[\d,]*\.\d{2}$/);

  // Add one of the fake feed's stocks to Stocks: its price arrives within seconds.
  await page.getByLabel('Add a symbol').fill('ztsta');
  await page.getByLabel('To group').selectOption({ label: 'Stocks' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const stocks = table.getByRole('rowgroup', { name: 'Stocks' });
  const row = stocks.getByRole('row', { name: /ZTSTA/ });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole('cell').nth(1)).toHaveText(/^\$\d[\d,]*\.\d{2}$/, { timeout: 20_000 });
  await expect(row.getByRole('cell').nth(3)).toHaveText(/^[+−]?\d+\.\d{2}%$/);

  // Groups fold, and the fold is remembered.
  await table.getByRole('button', { name: /^Indices/ }).click();
  await expect(indices.getByRole('row', { name: /SPY/ })).toBeHidden();
  await page.reload();
  await expect(table.getByRole('button', { name: /^Indices/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // A new group, renamed; a symbol removed.
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByLabel('New group name').fill('Watching');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(table.getByRole('rowgroup', { name: 'Watching' })).toBeVisible();
  await table.getByLabel('Watching group actions').first().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByLabel('Group name').fill('Later');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(table.getByRole('rowgroup', { name: 'Later' })).toBeVisible();

  await row.getByLabel('ZTSTA actions').click();
  await page.getByRole('menuitem', { name: 'Remove ZTSTA' }).click();
  await expect(stocks.getByRole('row', { name: /ZTSTA/ })).toHaveCount(0);

  // Opening a symbol opens its price chart.
  await page.getByLabel('Add a symbol').fill('ZTSTB');
  await page.getByLabel('To group').selectOption({ label: 'Stocks' });
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await stocks.getByRole('link', { name: /ZTSTB/ }).click();
  await expect(page).toHaveURL(/\/research\?instrument=[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTB/ })).toBeVisible();
});
