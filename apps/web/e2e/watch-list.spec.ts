import { expect, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The watch list (N292, N293, ADR 0101): named sections of symbols with live
 * Last, Chg and Chg%, each with its own "+", columns that sort, kept per
 * person. Prices come from the person's Alpaca feed (the fake, in E2E) and
 * the VIX from Cboe's daily history (also a fake).
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

async function addTo(page: Page, section: string, symbol: string) {
  const s = page.getByRole('region', { name: section });
  const plus = s.getByRole('button', { name: `Add a symbol to ${section}` });
  if ((await plus.getAttribute('aria-expanded')) !== 'true') await plus.click();
  await s.getByLabel(`Symbol to add to ${section}`).fill(symbol);
  await s.getByRole('button', { name: 'Add', exact: true }).click();
}

test('follows symbols in named sections with prices that update', async ({ page }) => {
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

  // A new list starts with two sections, Indices and Stocks.
  const indices = page.getByRole('region', { name: 'Indices' });
  const stocks = page.getByRole('region', { name: 'Stocks' });
  await expect(indices.getByRole('row', { name: /SPY/ })).toBeVisible();
  // The VIX is a daily close in points: no $, a D mark.
  const vix = indices.getByRole('row', { name: /VIX/ });
  await expect(vix.getByLabel('daily close')).toBeVisible({ timeout: 20_000 });
  await expect(vix.getByRole('cell').nth(1)).toHaveText(/^\d[\d,]*\.\d{2}$/);

  // Each section adds from its own +: a fake-feed stock's price arrives within seconds.
  await addTo(page, 'Stocks', 'ztsta');
  const row = stocks.getByRole('row', { name: /ZTSTA/ });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByRole('cell').nth(1)).toHaveText(/^\$\d[\d,]*\.\d{2}$/, {
    timeout: 20_000,
  });
  await expect(row.getByRole('cell').nth(3)).toHaveText(/^[+−]?\d+\.\d{2}%$/);
  await addTo(page, 'Stocks', 'ZTSTX');
  await expect(stocks.getByRole('row', { name: /ZTSTX/ })).toBeVisible({ timeout: 20_000 });

  // Headers sort: Last low to high, high to low, then back to the saved order.
  const symbols = () =>
    stocks
      .locator('tbody tr')
      .evaluateAll((rows) =>
        rows.map((r) => r.querySelector('td')?.textContent?.replace(/D$/, '').slice(2) ?? ''),
      );
  const lastHeader = stocks.getByRole('columnheader', { name: /Last/ });
  await stocks.getByRole('button', { name: /^Last/ }).click();
  await expect(lastHeader).toHaveAttribute('aria-sort', 'ascending');
  // Priced rows first, cheapest first; unpriced rows last.
  await expect.poll(async () => (await symbols()).slice(0, 2)).toEqual(['ZTSTA', 'ZTSTX']);
  await stocks.getByRole('button', { name: /^Last/ }).click();
  await expect(lastHeader).toHaveAttribute('aria-sort', 'descending');
  await expect.poll(async () => (await symbols()).slice(0, 2)).toEqual(['ZTSTX', 'ZTSTA']);
  await stocks.getByRole('button', { name: /^Last/ }).click();
  await expect(lastHeader).toHaveAttribute('aria-sort', 'none');
  await expect.poll(async () => (await symbols())[0]).toBe('AAPL');

  // Sections fold, and the fold is remembered.
  await indices.getByRole('button', { name: 'Close Indices' }).click();
  await expect(indices.getByRole('row', { name: /SPY/ })).toBeHidden();
  await page.reload();
  await expect(indices.getByRole('button', { name: 'Open Indices' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );

  // A new section, named, then renamed by double-click; a symbol removed.
  await page.getByRole('button', { name: '+ New section' }).click();
  await page.getByLabel('New section name').fill('Watching');
  await page.getByRole('button', { name: 'Save' }).click();
  const watching = page.getByRole('region', { name: 'Watching' });
  await expect(watching).toBeVisible();
  await watching.getByRole('heading', { name: /Watching/ }).dblclick();
  await watching.getByLabel('Section name').fill('Later');
  await watching.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('region', { name: 'Later' })).toBeVisible();

  await row.getByLabel('ZTSTA actions').click();
  await page.getByRole('menuitem', { name: 'Remove ZTSTA' }).click();
  await expect(stocks.getByRole('row', { name: /ZTSTA/ })).toHaveCount(0);

  // Opening a symbol opens its price chart.
  await addTo(page, 'Later', 'ZTSTB');
  await page.getByRole('region', { name: 'Later' }).getByRole('link', { name: /ZTSTB/ }).click();
  await expect(page).toHaveURL(/\/research\?instrument=[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTB/ })).toBeVisible();

  // The sidebar link reopens the last Research tab while you come back soon (N295)…
  const primary = page.getByRole('navigation', { name: 'Primary' });
  await page
    .getByRole('navigation', { name: 'Tools' })
    .getByRole('link', { name: 'Stock screener' })
    .click();
  await expect(page).toHaveURL(/\/research\/screener/);
  await page.goto('/orders');
  await primary.getByRole('link', { name: 'Quantitative Research' }).click();
  await expect(page).toHaveURL(/\/research\/screener$/);
  // …and the Watch list after a break.
  const stale = encodeURIComponent(`/research/screener|${Date.now() - 31 * 60_000}`);
  await page.context().addCookies([
    {
      name: 'tm_research_tab',
      value: stale,
      domain: new URL(page.url()).hostname,
      path: '/research',
    },
  ]);
  await page.goto('/orders');
  await primary.getByRole('link', { name: 'Quantitative Research' }).click();
  await expect(page).toHaveURL(/\/research\/watch-list$/);
});
