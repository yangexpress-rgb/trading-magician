import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Research › Options (options data brief v2 §10 item 8, ADR 0048): with the
 * options feed on, a real stock's page shows the figures row, the charts and
 * the app's computed chain, and the price chart gains the expected-move cone.
 * The test worker's CBOE is a local fake that prices a smile around 20%.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

test('shows a stock’s options figures, charts and computed chain', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('options-research'));
  await page.goto('/settings/data-feeds');
  await page.getByRole('button', { name: 'Add a feed', exact: true }).click();
  const prices = page.getByRole('dialog', { name: 'Add a data feed' });
  await prices.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await prices.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await prices.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await prices.getByLabel('Secret key').fill(FAKE_SECRET);
  await prices.getByRole('button', { name: 'Add feed' }).click();
  await expect(prices).toBeHidden();

  // Without the options feed, the section says how to get it.
  await page.goto('/research');
  const search = page.getByLabel('Search by ticker or company name');
  await search.fill('ztsta');
  await search.press('Enter');
  const options = page.getByRole('region', { name: 'Options' });
  await expect(options.getByText('CBOE delayed options (daily) is free')).toBeVisible({
    timeout: 15_000,
  });

  await page.goto('/settings/data-feeds');
  await page.getByRole('button', { name: 'Add an options data feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add an options data feed' });
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();

  await page.goto('/research');
  await search.fill('ztsta');
  await search.press('Enter');
  await expect(options.getByTestId('options-figures')).toBeVisible({ timeout: 30_000 });
  const iv30 = options.getByTestId('options-figures').locator('div', { hasText: /^IV30/ });
  await expect(iv30.getByRole('definition')).toHaveText(/^\d+\.\d%$/);
  await expect(options.getByText(/Chain at .* ET/)).toBeVisible();
  await expect(options.getByText('Options from CBOE delayed options (daily)')).toBeVisible();
  await expect(options.getByRole('figure', { name: /IV smile/ })).toBeVisible();
  await expect(options.getByRole('figure', { name: 'Open interest by strike' })).toBeVisible();

  // The chain table: computed IV, delta and gamma, never a bid or an ask.
  await options.getByText(/^Chain for .*computed IV/).click();
  const chain = options.getByRole('table', { name: /options expiring/ });
  await expect(chain.getByRole('columnheader')).toHaveText([
    'Call IV %',
    'Delta',
    'Gamma',
    'OI',
    'Volume',
    'Strike',
    'Put IV %',
    'Delta',
    'Gamma',
    'OI',
    'Volume',
  ]);
  await expect(options).not.toContainText(/\bBid\b|\bAsk\b/);

  // The expected-move cone on daily bars.
  await page.getByRole('button', { name: 'Show it on 3 months of daily bars' }).click();
  await expect(page.getByTestId('expected-move-cone')).toBeVisible({ timeout: 15_000 });

  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
});
