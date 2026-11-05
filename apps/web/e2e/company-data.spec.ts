import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Company data feeds (ADR 0031): SEC EDGAR is added as its own kind of feed
 * in Settings, then fills the company section in Quantitative Research and
 * the screener's company columns. The test worker's SEC EDGAR is a local
 * fake with the fake Alpaca's two made-up companies.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

test('adds SEC EDGAR as a company data feed and reads a company’s financials', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('company-data'));
  await page.goto('/settings/data-feeds');

  // No company data feed yet: the section says how to get one.
  await expect(page.getByRole('heading', { name: 'Company data feeds' })).toBeVisible();
  await expect(page.getByText('No company data feed yet')).toBeVisible();

  // Prices first, from the fake Alpaca, so a real stock can be picked.
  await page.getByRole('button', { name: 'Add a feed', exact: true }).click();
  const prices = page.getByRole('dialog', { name: 'Add a data feed' });
  await expect(prices.getByLabel('Provider').locator('option')).not.toContainText([/SEC/]);
  await prices.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await prices.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await prices.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await prices.getByLabel('Secret key').fill(FAKE_SECRET);
  await prices.getByRole('button', { name: 'Add feed' }).click();
  await expect(prices).toBeHidden();

  // Then company data, which asks only for a contact email.
  await page.getByRole('button', { name: 'Add a company data feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a company data feed' });
  await expect(add.getByLabel('Provider')).toHaveValue('sec');
  await expect(add.getByLabel('Name', { exact: true })).toHaveValue('SEC EDGAR');
  await expect(add.getByText('Asset classes')).toBeHidden();
  await add.getByLabel('Contact email').fill('research@example.test');
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();

  const companyFeeds = page.getByRole('list', { name: 'Company data feeds' });
  const sec = companyFeeds.getByRole('listitem', { name: 'SEC EDGAR' });
  await expect(sec.getByText('Healthy')).toBeVisible({ timeout: 15_000 });
  await expect(sec).toContainText('Company data');
  await expect(sec).toContainText('In use for company pages in Quantitative Research');
  await expect(sec).toContainText('Uses SEC EDGAR contact');
  // It is not a price feed: no routes, and not offered as one.
  await expect(
    page.getByRole('list', { name: 'Price feeds' }).getByRole('listitem', { name: 'SEC EDGAR' }),
  ).toHaveCount(0);
  await expect(
    page
      .getByLabel(/Primary feed for/)
      .first()
      .locator('option'),
  ).not.toContainText([/SEC EDGAR/]);
  const settingsScan = await new AxeBuilder({ page }).analyze();
  expect(settingsScan.violations).toEqual([]);

  // A real stock's chart now has its company section underneath.
  await page.goto('/research');
  const search = page.getByLabel('Search by ticker or company name');
  await search.fill('ztsta');
  await search.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTA/ })).toBeVisible({
    timeout: 15_000,
  });
  const company = page.getByRole('region', { name: 'Company' });
  await expect(company.getByText('Test Alpha Inc.')).toBeVisible({ timeout: 15_000 });
  await expect(company.getByText('Company data from SEC EDGAR')).toBeVisible();
  await expect(
    company.getByRole('definition').filter({ hasText: 'Springfield, IL' }),
  ).toBeVisible();
  const table = company.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText([
    'Line',
    'FY2021',
    'FY2022',
    'FY2023',
    'FY2024',
    'FY2025',
  ]);
  await expect(table.getByRole('row', { name: /^Revenue/ })).toContainText('$1.76B');
  await expect(
    company.getByRole('list', { name: 'Recent filings' }).getByRole('link').first(),
  ).toHaveText('10-K');
  const researchScan = await new AxeBuilder({ page }).analyze();
  expect(researchScan.violations).toEqual([]);

  // The screener gains market cap and P/E.
  await page.goto('/research/screener?universe=all');
  const results = page.getByRole('table', { name: 'Screen results' });
  await expect(results.locator('tbody tr')).toHaveCount(3, { timeout: 30_000 });
  await expect(results.getByRole('columnheader', { name: /Market cap/ })).toBeVisible();
  await expect(results.getByRole('columnheader', { name: /P\/E/ })).toBeVisible();
  await expect(page.getByText(/from SEC EDGAR; market cap is the last price/)).toBeVisible();
});
