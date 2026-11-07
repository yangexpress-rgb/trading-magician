import { expect, type Page } from '@playwright/test';
import { createStrategyWithRules, group, leg } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Design v1.2 item 6: fundamentals as strategy inputs. "Dividend yield > 3%"
 * is built in the condition builder's "Fundamental metric" category, saved,
 * shown back in the editor and back tested; the screener filtered by the
 * same metric returns the same stock. The test worker's SEC EDGAR is a local
 * fake: Test Beta (ZTSTB) declares about $11 a share a year (near 5%), Test Alpha
 * (ZTSTA) pays no dividend.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

async function addFeeds(page: Page) {
  await page.goto('/settings/data-feeds');
  await page.getByRole('button', { name: 'Add a feed', exact: true }).click();
  const prices = page.getByRole('dialog', { name: 'Add a data feed' });
  await prices.getByLabel('Provider').selectOption({ label: 'Alpaca' });
  await prices.getByLabel('Name', { exact: true }).fill('Alpaca prices');
  await prices.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await prices.getByLabel('Secret key').fill(FAKE_SECRET);
  await prices.getByRole('button', { name: 'Add feed' }).click();
  await expect(prices).toBeHidden();
  await page.getByRole('button', { name: 'Add a company data feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a company data feed' });
  await add.getByLabel('Contact email').fill('research@example.test');
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();
  await expect(
    page
      .getByRole('list', { name: 'Company data feeds' })
      .getByRole('listitem', { name: 'SEC EDGAR' })
      .getByText('Healthy'),
  ).toBeVisible({ timeout: 15_000 });
  // An Alpaca paper account to trade real US stocks on (the demo account trades demo ones).
  await page.goto('/settings/accounts');
  await page.getByRole('button', { name: 'Add a platform' }).click();
  const platform = page.getByRole('dialog', { name: 'Add a trading platform' });
  await platform.getByLabel('Platform').selectOption({ label: 'Alpaca' });
  await platform.getByLabel('Name', { exact: true }).fill('Alpaca');
  // The key stored with the price feed is offered again.
  await platform.getByLabel('API key', { exact: true }).selectOption({ label: 'Alpaca paper key' });
  await platform.getByRole('button', { name: 'Add platform' }).click();
  await expect(platform).toBeHidden();
  await expect(page.getByText('Alpaca paper ••••0042').first()).toBeVisible({ timeout: 15_000 });
}

async function instrumentId(page: Page, baseURL: string, symbol: string) {
  const headers = { origin: baseURL };
  const lookup = await (
    await page.request.post('/api/v1/instrument-lookups', { data: { symbol }, headers })
  ).json();
  let id = '';
  await expect
    .poll(
      async () => {
        const l = await (await page.request.get(`/api/v1/instrument-lookups/${lookup.id}`)).json();
        id = l.instrument?.id ?? '';
        return l.status;
      },
      { timeout: 20_000 },
    )
    .toBe('found');
  return id;
}

const dividendYieldAbove3 = (id: string) =>
  group('eg', {
    kind: 'comparison',
    id: 'dy',
    operator: 'gt',
    left: { kind: 'metric', id: 'dym', metric: 'dividend_yield', params: {}, instrumentId: id },
    right: { kind: 'constant', id: 'three', value: '0.03' },
  });

async function backtest(page: Page, baseURL: string, strategyId: string) {
  const headers = { origin: baseURL };
  const queued = await page.request.post(`/api/v1/strategies/${strategyId}/backtests`, {
    data: { from: '2025-06-02', to: '2026-09-30' },
    headers,
  });
  expect(queued.status(), await queued.text()).toBeLessThan(300);
  const run = await queued.json();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/v1/backtests/${run.id}`)).json()).status,
      { timeout: 90_000 },
    )
    .toBe('completed');
  return (await (await page.request.get(`/api/v1/backtests/${run.id}/trades`)).json()) as {
    trades: unknown[];
  };
}

test('dividend yield > 3%: saved, shown, back tested, and matched by the screener', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await signUpAndVerify(page, uniqueEmail('fundamentals'));
  const headers = { origin: baseURL! };

  // Without a company data feed, validation says what is missing.
  await page.goto('/settings/data-feeds');
  const early = await createStrategyWithRules(page, baseURL!, 'Too early', (ids, accountId) => ({
    entry: {
      condition: dividendYieldAbove3(ids['DEMO-A']!),
      trigger: { mode: 'on_transition', cooldownSec: 0, confirmationBars: 0 },
      orders: [leg('buy', 'Buy DEMO-A', ids['DEMO-A']!, accountId, 'buy')],
    },
  }));
  const missing = await (
    await page.request.post(`/api/v1/strategies/${early.id}/validate`, { headers })
  ).json();
  expect(missing.errors.map((e: { code: string }) => e.code)).toContain('missing_company_feed');

  await addFeeds(page);
  const beta = await instrumentId(page, baseURL!, 'ZTSTB');
  const alpha = await instrumentId(page, baseURL!, 'ZTSTA');

  // The screener, filtered by dividend yield above 3%: Test Beta only.
  await page.goto('/research/screener?universe=all&f=dividendYieldPct:3:');
  const results = page.getByRole('table', { name: 'Screen results' });
  await expect(results.getByRole('columnheader', { name: /Dividend yield/ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(results.locator('tbody tr')).toHaveCount(1, { timeout: 60_000 });
  await expect(results.locator('tbody tr').first()).toContainText('ZTSTB');

  // The same rule as a strategy: buy ZTSTB while its dividend yield is above 3%.
  // Entry fires while the condition holds (it already does on the first bar).
  const trigger = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };
  const rules =
    (id: string, symbol: string) => (_ids: Record<string, string>, accountId: string) => ({
      entry: {
        condition: dividendYieldAbove3(id),
        trigger,
        orders: [leg('buy', `Buy ${symbol}`, id, accountId, 'buy')],
      },
      exit: {
        condition: group('xg', {
          kind: 'comparison',
          id: 'never',
          operator: 'lt',
          left: { kind: 'constant', id: 'one', value: '1' },
          right: { kind: 'constant', id: 'zero', value: '0' },
        }),
        trigger,
        rules: [{ kind: 'timeStop', id: 'hold', barsHeld: 20 }],
        orders: [leg('sell', `Sell ${symbol}`, id, accountId, 'close')],
      },
    });
  const strategy = await createStrategyWithRules(
    page,
    baseURL!,
    'High yield',
    rules(beta, 'ZTSTB'),
  );
  const validation = await (
    await page.request.post(`/api/v1/strategies/${strategy.id}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);

  // Shown back in the condition builder as a Fundamental metric.
  await page.goto(`/strategy-lab/${strategy.id}`);
  const typeSelect = page.locator('select').filter({
    has: page.locator('option:checked', { hasText: 'Fundamental metric (company filings)' }),
  });
  await expect(typeSelect.first()).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('select').filter({
      has: page.locator('option:checked', { hasText: 'Dividend yield' }),
    }),
  ).toHaveCount(1);

  // Back tested: it buys ZTSTB, which yields about 5%.
  expect((await backtest(page, baseURL!, strategy.id)).trades.length).toBeGreaterThan(0);

  // The stock the screener left out never qualifies: it pays no dividend, so its yield is 0%.
  const none = await createStrategyWithRules(page, baseURL!, 'No yield', rules(alpha, 'ZTSTA'));
  expect((await backtest(page, baseURL!, none.id)).trades).toEqual([]);
});
