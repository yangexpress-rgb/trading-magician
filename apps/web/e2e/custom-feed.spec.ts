import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Custom REST (JSON) feeds (ADR 0041): described in Settings, tested with a
 * symbol before saving, routed like any feed, removed back to Alpaca. The
 * worker reaches a made-up JSON API (CUSTOM_REST_FAKE in playwright.config.ts)
 * and the fake Alpaca.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';
const CUSTOM_KEY = 'fake-key';
const SHOTS = process.env.CUSTOM_FEED_SHOTS;

test('adds, tests, routes and removes a custom JSON price feed', async ({ page }) => {
  test.setTimeout(120_000);
  await signUpAndVerify(page, uniqueEmail('custom-feed'));
  await page.goto('/settings/data-feeds');
  const feeds = page.getByRole('list', { name: 'Price feeds' });

  // Alpaca first, as in Yong's setup.
  await page.getByRole('button', { name: 'Add a feed' }).click();
  let add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await add.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await add.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await add.getByLabel('Secret key').fill(FAKE_SECRET);
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();
  await expect(
    feeds.getByRole('listitem', { name: 'Alpaca prices' }).getByText('Healthy'),
  ).toBeVisible();

  // The custom feed, described field by field.
  await page.getByRole('button', { name: 'Add a feed' }).click();
  add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add.getByLabel('Provider').selectOption({ label: 'Custom REST (JSON)' });
  await expect(add).toContainText(
    'You are responsible for your provider’s terms — most free tiers do not allow showing their data to other users.',
  );
  await add.getByLabel('Name', { exact: true }).fill('My JSON prices');
  await add.getByLabel('Base URL').fill('https://10.0.0.8/v1');
  await add.getByLabel('Sign-in').selectOption({ label: 'API key in a query parameter' });
  await add.getByLabel('Query parameter name').fill('token');
  await add.getByLabel('API key or token').fill(CUSTOM_KEY);
  await add
    .getByLabel('Daily bars URL')
    .fill('https://prices.example.test/v1/daily?symbol={symbol}&start={from}&end={to}');
  await add.getByLabel('Latest quote URL').fill('/last?symbol={symbol}');
  await add.getByLabel('Bar date', { exact: true }).fill('data.bars[].date');
  for (const f of ['open', 'high', 'low', 'close', 'volume']) {
    await add
      .getByLabel(f[0]!.toUpperCase() + f.slice(1), { exact: true })
      .fill(`data.bars[].${f}`);
  }
  await add.getByLabel('Quote last price').fill('quote.price');
  await add.getByLabel('Quote bid (optional)').fill('quote.bid');
  await add.getByLabel('Quote ask (optional)').fill('quote.ask');
  await add.getByLabel('Quote time (optional)').fill('quote.time');
  await add.getByLabel('Provider’s documented limit (requests a minute)').fill('60');

  // Saving waits for a passing test; a private address is refused before anything is fetched.
  await expect(add.getByRole('button', { name: 'Add feed' })).toBeDisabled();
  await add.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(
    add.getByText('Use the provider’s host name, not an IP address').first(),
  ).toBeVisible();

  // A wrong path gets the exact reason.
  await add.getByLabel('Base URL').fill('https://prices.example.test/v1');
  await add.getByLabel('Close', { exact: true }).fill('data.bars[].last');
  await add.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(add.getByText('The test failed')).toBeVisible();
  await expect(add).toContainText(
    'Bar 1: the answer has no “last” (it has date, open, high, low, close, volume)',
  );
  await expect(add.getByRole('button', { name: 'Add feed' })).toBeDisabled();

  // Fixed, it passes with SPY and shows what it read.
  await add.getByLabel('Close', { exact: true }).fill('data.bars[].close');
  await add.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(add.getByText(/^Test passed: \d+ daily bars for SPY/)).toBeVisible();
  await expect(add.getByRole('table', { name: 'Latest bars read for SPY' })).toBeVisible();
  expect(await page.content()).not.toContain(CUSTOM_KEY);
  if (SHOTS) await add.screenshot({ path: `${SHOTS}/custom-feed-form.png` });
  const axe = await new AxeBuilder({ page }).include('dialog').analyze();
  expect(axe.violations).toEqual([]);

  // Changing a setting after the test asks for another one.
  await add.getByLabel('Timeout (seconds)').fill('4');
  await expect(add.getByRole('button', { name: 'Add feed' })).toBeDisabled();
  await add.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(add.getByText(/^Test passed/)).toBeVisible();
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();

  // It joins routing as the backup of Alpaca's routes, and is health-checked.
  const custom = feeds.getByRole('listitem', { name: 'My JSON prices' });
  await expect(custom.getByText('Healthy')).toBeVisible();
  await expect(custom).toContainText('Daily bars and latest quotes from prices.example.test');
  await custom.getByRole('button', { name: 'Make My JSON prices primary for ETFs bars' }).click();
  const routes = custom.getByRole('table', { name: 'Routes for My JSON prices' });
  await expect(routes).toContainText('ETFs bars');
  if (SHOTS) await custom.screenshot({ path: `${SHOTS}/custom-feed-routes.png` });

  // The stored key is listed but never shown.
  await page.goto('/settings/data-feeds');
  expect(await page.content()).not.toContain(CUSTOM_KEY);

  // Removing it hands its routes back to Alpaca.
  await feeds
    .getByRole('listitem', { name: 'My JSON prices' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await page
    .getByRole('dialog', { name: 'Remove My JSON prices?' })
    .getByRole('button', { name: 'Remove feed' })
    .click();
  await expect(feeds.getByRole('listitem', { name: 'My JSON prices' })).toHaveCount(0);
  await expect(
    feeds
      .getByRole('listitem', { name: 'Alpaca prices' })
      .getByRole('table', { name: 'Routes for Alpaca prices' }),
  ).toContainText('ETFs bars');
});
