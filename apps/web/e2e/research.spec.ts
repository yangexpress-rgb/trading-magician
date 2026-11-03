import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Quantitative Research (§11, ADR 0029): pick a stock and chart its prices.
 * Demo instruments are charted from the generated history through the demo
 * feed; the Alpaca path is covered by the worker's integration tests.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

test('picks a stock and reads its price chart', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('research'));
  await page.goto('/research');

  // Opens on the broad-market demo ETF.
  const chartHeading = page.getByRole('heading', { level: 2, name: /DEMO-IDX/ });
  await expect(chartHeading).toBeVisible();
  const chart = page.getByTestId('price-chart');
  await expect(chart).toBeVisible();
  await expect(chart).toHaveAttribute('aria-label', /DEMO-IDX, daily prices over 1 year/);
  await expect(page.getByTestId('chart-summary')).toContainText('1 year');
  await expect(page.getByText(/Prices from /)).toBeVisible();

  // Search and pick another stock; the address keeps the choice.
  await page.getByLabel('Search').fill('software c');
  await page.getByRole('button', { name: /DEMO-C/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: /DEMO-C/ })).toBeVisible();
  await expect(chart).toHaveAttribute('aria-label', /^DEMO-C, daily/);
  await expect(page).toHaveURL(/instrument=[0-9a-f-]{36}/);

  // Hourly bars over a month, as candles.
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1M' }).click();
  await page.getByRole('group', { name: 'Bars' }).getByRole('button', { name: 'Hourly' }).click();
  await page.getByRole('group', { name: 'Chart' }).getByRole('button', { name: 'Candles' }).click();
  await expect(chart).toHaveAttribute('aria-label', /DEMO-C, hourly prices over 1 month/);
  await expect(page).toHaveURL(/range=1m&interval=1h&style=candles/);

  // Hourly is not offered for a year; picking a year falls back to daily.
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1Y' }).click();
  await expect(
    page.getByRole('group', { name: 'Bars' }).getByRole('button', { name: 'Hourly' }),
  ).toBeDisabled();
  await expect(chart).toHaveAttribute('aria-label', /DEMO-C, daily prices over 1 year/);

  // The keyboard reads bars: Home goes to the first one.
  const readout = page.getByTestId('chart-readout');
  await expect(readout).toContainText('latest');
  await chart.focus();
  await page.keyboard.press('Home');
  await expect(readout).not.toContainText('latest');
  await expect(readout).toContainText('Close');

  // Every value is in the table too.
  await page.getByText('Show prices as a table').click();
  await expect(page.getByRole('table', { name: 'DEMO-C prices' })).toBeVisible();

  // Reloading keeps the chart.
  await page.reload();
  await expect(page.getByRole('heading', { level: 2, name: /DEMO-C/ })).toBeVisible();
  await expect(page.getByTestId('price-chart')).toHaveAttribute('aria-label', /^DEMO-C/);
});

test('finds a US stock by symbol and charts it from the Alpaca feed', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('research-alpaca'));
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
  await page.getByLabel('Symbol').fill('ztsta');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTA/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId('price-chart')).toHaveAttribute('aria-label', /^ZTSTA, daily/, {
    timeout: 15_000,
  });
  await expect(page.getByText('Prices from Alpaca prices')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your US stocks and ETFs' })).toContainText('ZTSTA');
});
