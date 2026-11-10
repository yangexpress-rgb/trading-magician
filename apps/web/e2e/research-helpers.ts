import { expect, type Page } from '@playwright/test';

/**
 * Opens the stock picker on the Price charts page (N199): it has no card of
 * its own, so double-click the charted symbol in the chart's title.
 */
export async function openStockPicker(page: Page): Promise<void> {
  const picker = page.getByRole('dialog', { name: 'Change stock' });
  if (await picker.isVisible()) return;
  await page.getByTestId('chart-symbol').dblclick();
  await expect(picker).toBeVisible();
}

/** Opens a closed section under the price chart, such as Options or Company (N200). */
export async function openSection(page: Page, name: string): Promise<void> {
  const toggle = page.getByRole('region', { name }).getByRole('button', { name, exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
