import { expect } from '@playwright/test';
import { openStockPicker } from './research-helpers';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The chart follows the selected instrument on every switch (N153), including
 * the first one after the page loads, and never shows the previous
 * instrument's prices under the new one's name while its chart loads or after
 * it failed.
 */

test('every switch shows the selected instrument’s chart', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('switch'));
  await page.goto('/research');
  const chart = page.getByTestId('price-chart');
  await expect(chart).toHaveAttribute('aria-label', /^DEMO-IDX,/);
  for (const sym of ['DEMO-C', 'DEMO-A', 'DEMO-IDX', 'DEMO-B']) {
    await openStockPicker(page);
    await page.getByLabel('Search').fill(sym);
    await page
      .getByRole('button', { name: new RegExp(`^${sym}\\b`) })
      .first()
      .click();
    await expect(page.getByRole('heading', { level: 2, name: new RegExp(sym) })).toBeVisible();
    await expect(chart).toHaveAttribute('aria-label', new RegExp(`^${sym},`));
    await expect(page.getByTestId('chart-summary')).toBeVisible();
  }
});

test('a switch whose chart is slow or fails never shows the previous instrument’s chart', async ({
  page,
}) => {
  await signUpAndVerify(page, uniqueEmail('switch-slow'));
  await page.goto('/research');
  const chart = page.getByTestId('price-chart');
  await expect(chart).toHaveAttribute('aria-label', /^DEMO-IDX,/);

  // DEMO-C's chart is slow: while it loads, DEMO-IDX's prices are not shown under DEMO-C.
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/research/price-charts', async (route) => {
    await held;
    await route.continue();
  });
  await openStockPicker(page);
  await page.getByLabel('Search').fill('DEMO-C');
  await page
    .getByRole('button', { name: /^DEMO-C\b/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 2, name: /DEMO-C/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Loading DEMO-C prices' })).toBeVisible();
  await expect(chart).toHaveCount(0);
  await expect(page.getByTestId('chart-readout')).toHaveCount(0);
  await expect(page.getByTestId('chart-summary')).toHaveCount(0);
  release();
  await expect(chart).toHaveAttribute('aria-label', /^DEMO-C,/);
  await page.unroute('**/api/v1/research/price-charts');

  // DEMO-A's chart fails: the error shows, with no other instrument's chart under it.
  await page.route('**/api/v1/research/price-charts', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'unavailable', message: 'The prices could not be loaded.' },
      }),
    }),
  );
  await openStockPicker(page);
  await page.getByLabel('Search').fill('DEMO-A');
  await page
    .getByRole('button', { name: /^DEMO-A\b/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 2, name: /DEMO-A/ })).toBeVisible();
  await expect(page.getByText('The prices could not be loaded.')).toBeVisible();
  await expect(chart).toHaveCount(0);
  await expect(page.getByTestId('chart-readout')).toHaveCount(0);
});
