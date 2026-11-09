import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Alpaca market data end to end (§9.2, ADR 0017). The worker talks to a fake
 * Alpaca with made-up symbols (ALPACA_FAKE in playwright.config.ts), which
 * accepts only this throwaway key.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

test('connects an Alpaca feed and finds a US stock for a strategy', async ({ page, baseURL }) => {
  await signUpAndVerify(page, uniqueEmail('alpaca'));
  await page.goto('/settings/data-feeds');

  await page.getByRole('button', { name: 'Add a feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await add.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await add.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await add.getByLabel('Secret key').fill(FAKE_SECRET);
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();
  const feed = page
    .getByRole('list', { name: 'Price feeds' })
    .getByRole('listitem', { name: 'Alpaca prices' });
  await expect(feed.getByText('Healthy')).toBeVisible();
  await expect(feed).toContainText('Entitled');
  expect(await page.content()).not.toContain(FAKE_SECRET);

  // Adding the feed routes US stocks and ETFs on any venue to it, listed under it (ADR 0038).
  const feedRoutes = feed.getByRole('table', { name: 'Routes for Alpaca prices' });
  await expect(feedRoutes).toContainText('Stocks live prices');
  await expect(feedRoutes).toContainText('Stocks bars');
  await expect(feedRoutes).toContainText('Any US venue');

  const created = await (
    await page.request.post('/api/v1/strategies', {
      data: { name: 'Real stock watcher' },
      headers: { origin: baseURL! },
    })
  ).json();
  await page.goto(`/strategy-lab/${created.id}`);
  // Any symbol can be typed straight into a leg's picker: no list to add to first (N190).
  await page.getByRole('button', { name: '+ Add Entry order' }).click();
  const leg = page.getByRole('region', { name: 'Entry leg 1', exact: true });
  const picker = leg.getByLabel('Instrument', { exact: true });
  await picker.selectOption({ label: 'Another stock, ETF or index…' });
  await leg.getByLabel('Symbol or company name').fill('ztsta');
  await leg.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(picker.locator('option:checked')).toContainText('ZTSTA');
  await expect(leg.getByLabel('Symbol or company name')).toBeHidden();

  await picker.selectOption({ label: 'Another stock, ETF or index…' });
  await leg.getByLabel('Symbol or company name').fill('NOSUCH');
  await leg.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(leg.getByText('No US stock or ETF matches “NOSUCH”.')).toBeVisible();
  await expect(picker.locator('option:checked')).toContainText('ZTSTA');

  // It stays available to this person's strategies.
  await page.reload();
  await page.getByRole('button', { name: '+ Add Entry order' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Entry leg 1', exact: true })
      .getByLabel('Instrument', { exact: true })
      .locator('option', { hasText: 'ZTSTA' }),
  ).toHaveCount(1);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});
