import { expect } from '@playwright/test';
import { openStockPicker } from './research-helpers';
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
  // Opens on the latest session: 5-minute bars, as a line.
  await expect(chart).toHaveAttribute('aria-label', /DEMO-IDX, 5-minute prices over 1 day/);
  await expect(page.getByTestId('chart-summary')).toContainText('1 day');
  await expect(
    page.getByRole('group', { name: 'Chart' }).getByRole('button', { name: 'Line' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Prices from /)).toBeVisible();

  // The picker opens from the charted symbol (N199); without a real data feed it says how
  // to search every US stock.
  await openStockPicker(page);
  await expect(page.getByTestId('needs-feed')).toContainText('add an Alpaca data feed');
  // Esc closes it again.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Change stock' })).toBeHidden();

  // Picking another stock opens it on 1D, 5-minute bars, line, whatever was shown before.
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1Y' }).click();
  await page.getByRole('group', { name: 'Chart' }).getByRole('button', { name: 'Candles' }).click();
  await expect(chart).toHaveAttribute('aria-label', /DEMO-IDX, daily prices over 1 year/);
  await openStockPicker(page);
  await page.getByLabel('Search').fill('software c');
  await page.getByRole('button', { name: /DEMO-C/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: /DEMO-C/ })).toBeVisible();
  await expect(chart).toHaveAttribute('aria-label', /^DEMO-C, 5-minute prices over 1 day/);
  await expect(page).not.toHaveURL(/style=candles/);
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

  // One day: the latest session in 5-minute bars, with times on the axis.
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1D' }).click();
  await expect(chart).toHaveAttribute('aria-label', /DEMO-C, 5-minute prices over 1 day/);
  await expect(page).toHaveURL(/range=1d&interval=5m/);
  await expect(
    page.getByRole('group', { name: 'Bars' }).getByRole('button', { name: 'Daily' }),
  ).toBeDisabled();
  await expect(page.getByTestId('chart-readout')).toContainText(/ET/);
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1Y' }).click();
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

test('finds a US stock by name or ticker and charts it from the Alpaca feed', async ({ page }) => {
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
  await openStockPicker(page);
  await expect(page.getByTestId('needs-feed')).toBeHidden();

  // A company name finds the listing to pick, then its chart.
  await page.getByLabel('Search by ticker or company name').fill('beta');
  await page.getByRole('button', { name: 'Search all US stocks for “beta”' }).click();
  await expect(page.getByText('Did you mean one of these?')).toBeVisible({ timeout: 15_000 });
  await page
    .getByRole('list', { name: 'Matching US stocks and ETFs' })
    .getByRole('button', { name: /ZTSTB/ })
    .click();
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTB/ })).toBeVisible({
    timeout: 15_000,
  });
  // It opens on 1D. The test worker's fake Alpaca runs on a shifted paper clock, so it has
  // no bars for this week; a year of daily bars shows the feed's chart.
  const range = page.getByRole('group', { name: 'Range' });
  await expect(range.getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true');
  await range.getByRole('button', { name: '1Y' }).click();
  await expect(page.getByTestId('price-chart')).toHaveAttribute('aria-label', /^ZTSTB, daily/, {
    timeout: 15_000,
  });
  await expect(page.getByText('Prices from Alpaca prices')).toBeVisible();

  // An exact ticker, submitted with Enter, is charted straight away.
  await openStockPicker(page);
  const search = page.getByLabel('Search by ticker or company name');
  await search.fill('ztsta');
  await search.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name: /ZTSTA/ })).toBeVisible({
    timeout: 15_000,
  });
  await openStockPicker(page);
  await expect(
    page.getByRole('list', { name: 'Your US stocks and ETFs' }).getByRole('button'),
  ).toHaveText([/ZTSTA/, /ZTSTB/]);
});
