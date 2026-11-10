import { expect } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { openStockPicker } from './research-helpers';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Design v1.2 item 5: the VIX as an indicator-only instrument. Its daily
 * history comes from the CBOE feed (a made-up file in tests, CBOE_FAKE), it
 * can be watched by conditions and charted in Research, and no leg can trade it.
 */

const band = (id: string, fn: string, vix: string) => ({
  kind: 'stat',
  id,
  fn,
  input: { kind: 'market', id: `${id}-in`, ...series(vix) },
  period: 20,
  multiplier: '2',
});

test('VIX: added from search, watched by conditions, charted, never traded', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(150_000);
  await signUpAndVerify(page, uniqueEmail('vix'));
  const headers = { origin: baseURL! };

  // The CBOE feed: free, no key, routed for daily bars only.
  await page.goto('/settings/data-feeds');
  await page.getByRole('button', { name: 'Add a feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add
    .getByLabel('Provider')
    .selectOption({ label: 'CBOE index history (daily) (free, VIX, end of day)' });
  await add.getByLabel('Name').fill('CBOE index history');
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();
  const cboe = page
    .getByRole('list', { name: 'Price feeds' })
    .getByRole('listitem', { name: 'CBOE index history' });
  await expect(cboe.getByText('Healthy')).toBeVisible({ timeout: 30_000 });
  const routes = cboe.getByRole('table', { name: 'Routes for CBOE index history' });
  await expect(routes).toContainText('bars');
  await expect(routes).not.toContainText('live prices');

  // Search finds the index itself, badged, never a VIX-futures ETF.
  const created = await (
    await page.request.post('/api/v1/strategies', { data: { name: 'VIX watcher' }, headers })
  ).json();
  await page.goto(`/strategy-lab/${created.id}`);
  // Typed into a leg's picker, the index is found but refused: legs can't trade it.
  await page.getByRole('button', { name: '+ Add Entry order' }).click();
  const legRegion = page.getByRole('region', { name: 'Entry leg 1', exact: true });
  const legPicker = legRegion.getByLabel('Instrument', { exact: true });
  await legPicker.selectOption({ label: 'Another stock, ETF or index…' });
  await legRegion.getByLabel('Symbol or company name').fill('VIX');
  await legRegion.getByRole('button', { name: 'Use', exact: true }).click();
  await expect(legRegion.getByText(/VIX is an index: conditions can watch it/)).toBeVisible();
  await expect(legPicker.locator('option', { hasText: 'VIX' })).toHaveCount(0);

  // A condition's picker offers it, badged, once it has been looked up.
  const entry = page.getByRole('region', { name: 'Entry trigger' });
  await entry.getByRole('button', { name: 'Add condition to Entry trigger' }).click();
  await expect(
    entry
      .getByLabel('Instrument')
      .first()
      .locator('option', { hasText: 'VIX · CBOE Volatility Index · Index — not tradable' }),
  ).toHaveCount(1);

  // The VIX's id, from the same lookup the editor used.
  const lookup = await (
    await page.request.post('/api/v1/instrument-lookups', { data: { symbol: 'VIX' }, headers })
  ).json();
  let vixId = '';
  await expect
    .poll(async () => {
      const l = await (await page.request.get(`/api/v1/instrument-lookups/${lookup.id}`)).json();
      vixId = l.instrument?.id ?? '';
      return l.status;
    })
    .toBe('found');

  // The brief's fixture: buy when VIX closes above its upper band, exit below the middle.
  const trigger = { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 };
  const strategy = await createStrategyWithRules(page, baseURL!, 'VIX bands', (ids, accountId) => ({
    entry: {
      condition: group('eg', {
        kind: 'comparison',
        id: 'up',
        operator: 'gt',
        left: { kind: 'market', id: 'vc', ...series(vixId) },
        right: band('bu', 'BB_UPPER', vixId),
      }),
      trigger,
      orders: [leg('buy', 'Buy DEMO-IDX', ids['DEMO-IDX']!, accountId, 'buy')],
    },
    exit: {
      condition: group('xg', {
        kind: 'comparison',
        id: 'down',
        operator: 'lt',
        left: { kind: 'market', id: 'vc2', ...series(vixId) },
        right: band('bm', 'BB_MIDDLE', vixId),
      }),
      trigger,
      orders: [leg('sell', 'Sell DEMO-IDX', ids['DEMO-IDX']!, accountId, 'close')],
    },
  }));
  const validation = await (
    await page.request.post(`/api/v1/strategies/${strategy.id}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);

  // Two years back tested: at least one entry, on VIX's daily bars.
  const queued = await page.request.post(`/api/v1/strategies/${strategy.id}/backtests`, {
    data: { from: '2024-01-02', to: '2025-12-31' },
    headers,
  });
  expect(queued.status(), await queued.text()).toBeLessThan(300);
  const run = await queued.json();
  await expect
    .poll(
      async () => (await (await page.request.get(`/api/v1/backtests/${run.id}`)).json()).status,
      { timeout: 60_000 },
    )
    .toBe('completed');
  const { trades } = await (await page.request.get(`/api/v1/backtests/${run.id}/trades`)).json();
  expect(trades.length).toBeGreaterThan(0);

  // VIX as a traded leg: validation says why.
  const current = await (await page.request.get(`/api/v1/strategies/${strategy.id}`)).json();
  const definition = structuredClone(current.definition);
  definition.entry.orders[0].instrumentId = vixId;
  const saved = await page.request.patch(`/api/v1/strategies/${strategy.id}`, {
    data: { rowVersion: current.rowVersion, definition },
    headers,
  });
  expect(saved.status()).toBe(200);
  const refused = await (
    await page.request.post(`/api/v1/strategies/${strategy.id}/validate`, { headers })
  ).json();
  expect(refused.errors.map((e: { message: string }) => e.message)).toContain(
    'VIX is an index: it can be watched in conditions but not traded, so it can\'t be the instrument of "Buy DEMO-IDX"',
  );
  await page.goto(`/strategy-lab/${strategy.id}`);
  await expect(
    page.getByText(/VIX is an index: it can be watched in conditions/).first(),
  ).toBeVisible();

  // Research charts years of daily VIX history, badged.
  await page.goto('/research');
  await openStockPicker(page);
  await page.getByRole('list', { name: 'Indices' }).getByRole('button', { name: /VIX/ }).click();
  await expect(page.getByRole('heading', { name: /VIX/ })).toContainText('Index — not tradable');
  await expect(page.getByTestId('chart-summary')).toBeVisible({ timeout: 30_000 });
  expect(page.url()).toContain('range=5y');
});
