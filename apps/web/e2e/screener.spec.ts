import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The stock screener (§11, ADR 0030): every stock the data feed covers, one
 * row each, sorted and filtered by any column. The demo instruments without a
 * real feed; every listed US stock through Alpaca (the fake, in E2E).
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

test('screens the demo instruments by any column', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('screener'));
  await page.goto('/research');
  await page
    .getByRole('navigation', { name: 'Tools' })
    .getByRole('link', {
      name: 'Stock screener',
    })
    .click();
  await expect(page).toHaveURL(/\/research\/screener/);
  await expect(page.getByText('The screener shows the demo instruments.')).toBeVisible();

  const results = page.getByRole('table', { name: 'Screen results' });
  const body = results.locator('tbody tr');
  await expect(body).toHaveCount(7, { timeout: 30_000 });
  await expect(page.getByText('7 of 7 stocks and ETFs match')).toBeVisible();
  await expect(page.getByText('Prices from Demo')).toBeVisible();

  // Sort by today's change, biggest first, then the other way.
  const header = (name: RegExp) => results.getByRole('columnheader', { name });
  await header(/Today’s change %/)
    .getByRole('button')
    .click();
  await expect(header(/Today’s change %/)).toHaveAttribute('aria-sort', 'descending');
  await expect(page).toHaveURL(/sort=changePct\.desc/);
  await header(/Today’s change %/)
    .getByRole('button')
    .click();
  await expect(header(/Today’s change %/)).toHaveAttribute('aria-sort', 'ascending');

  // Filters are compact pills (N195): no min and max boxes under the headings.
  const filters = page.getByRole('toolbar', { name: 'Screen filters' });
  await expect(page.getByLabel('Last price, at least')).toHaveCount(0);

  // Narrow to ETFs, then to a price range nothing is in; each applies at once.
  await filters.getByRole('button', { name: /^Type/ }).click();
  await page.getByRole('dialog', { name: 'Type' }).getByRole('radio', { name: 'ETFs' }).click();
  await expect(body).toHaveCount(2);
  await expect(page.getByText('2 of 7 stocks and ETFs match')).toBeVisible();
  await expect(filters.getByRole('button', { name: /^Type: ETFs/ })).toBeVisible();
  await filters.getByRole('button', { name: /^Last price/ }).click();
  await page.getByLabel('Last price, at least').fill('1M');
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
  await expect(page).toHaveURL(/f=last%3A1000000%3A/);
  await page.keyboard.press('Escape');
  await expect(filters.getByRole('button', { name: /^Last price: ≥ 1M/ })).toBeVisible();

  // The rarer filters wait in the Filter menu until asked for.
  await expect(filters.getByRole('button', { name: /^Exchange/ })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Add a filter' }).click();
  await page.getByRole('menuitem', { name: 'Exchange' }).click();
  await expect(page.getByRole('dialog', { name: 'Exchange' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Left empty, it goes back to the menu.
  await expect(filters.getByRole('button', { name: /^Exchange/ })).toHaveCount(0);

  // Clearing brings everything back; the address forgets the filters.
  await page.getByRole('button', { name: /Clear filters \(2\)/ }).click();
  await expect(body).toHaveCount(7);

  // Columns can be added; filters survive a reload.
  await page.getByText(/^Columns \(/).click();
  await page.getByRole('checkbox', { name: /^1-month high/ }).check();
  await expect(header(/^1-month high/)).toBeVisible();
  await page.getByLabel('Symbol or name').fill('software');
  await expect(body).toHaveCount(2);
  await page.reload();
  await expect(page.getByLabel('Symbol or name')).toHaveValue('software');
  await expect(body).toHaveCount(2, { timeout: 30_000 });
  await expect(header(/^1-month high/)).toBeVisible();

  // A symbol opens its price chart.
  await results.getByRole('link', { name: 'DEMO-C' }).click();
  await expect(page).toHaveURL(/\/research\?instrument=[0-9a-f-]{36}/);
  await expect(page.getByRole('heading', { level: 2, name: /DEMO-C/ })).toBeVisible();
});

test('screens every listed US stock through an Alpaca feed', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('screener-alpaca'));
  await page.goto('/settings/data-feeds');
  await page.getByRole('button', { name: 'Add a feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await add.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await add.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await add.getByLabel('Secret key').fill(FAKE_SECRET);
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();

  await page.goto('/research/screener');
  await expect(page.getByText('The screener shows the demo instruments.')).toBeHidden();
  const results = page.getByRole('table', { name: 'Screen results' });
  // A real feed opens on the S&P 500, which has none of the fake's made-up symbols.
  const filters = page.getByRole('toolbar', { name: 'Screen filters' });
  await expect(filters.getByRole('button', { name: /^Stock group: S&P 500/ })).toBeVisible();
  await expect(page.getByText('0 of 0 S&P 500 stocks match')).toBeVisible({ timeout: 30_000 });
  await filters.getByRole('button', { name: /^Stock group/ }).click();
  await page.getByRole('radio', { name: 'All US stocks' }).click();
  await expect(page).toHaveURL(/universe=all/);
  await expect(results.locator('tbody tr')).toHaveCount(3);
  await expect(page.getByText('Prices from Alpaca prices')).toBeVisible();
  await expect(page.getByText(/IEX exchange trades only/)).toBeVisible();

  // A stock that is not registered yet is looked up, then charted.
  await results.getByRole('button', { name: 'ZTSTB' }).click();
  await expect(page).toHaveURL(/\/research\?instrument=[0-9a-f-]{36}/, { timeout: 15_000 });
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTB/ })).toBeVisible();
});
