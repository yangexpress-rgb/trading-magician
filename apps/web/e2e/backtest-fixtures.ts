import { expect, type Page } from '@playwright/test';

/** Instrument ids as the editor lists them, read from a leg's Instrument picker. */
export async function instrumentIds(page: Page, strategyId: string) {
  await page.goto(`/strategy-lab/${strategyId}`);
  await page.getByRole('button', { name: '+ Add Entry order' }).click();
  const options = page
    .getByRole('region', { name: 'Entry leg 1', exact: true })
    .getByLabel('Instrument', { exact: true })
    .locator('option');
  const ids: Record<string, string> = {};
  for (const o of await options.all()) {
    const symbol = (await o.textContent())?.split(' ·')[0]?.trim();
    const value = await o.getAttribute('value');
    if (symbol && value) ids[symbol] = value;
  }
  return ids;
}

export const series = (instrumentId: string) => ({
  instrumentId,
  field: 'close',
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});

export function leg(
  id: string,
  label: string,
  instrumentId: string,
  accountId: string,
  side: string,
) {
  return {
    id,
    legLabel: label,
    instrumentId,
    accountId,
    side,
    quantity: { type: 'units', value: '20', rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    extendedHours: false,
    timing: { mode: 'immediate' },
    timingOnly: false,
  };
}

export const group = (id: string, comparison: Record<string, unknown>) => ({
  kind: 'group',
  id,
  op: 'and',
  negate: false,
  children: [comparison],
});

/**
 * Trades DEMO-A's 20-day average crossover. As a pair it also shorts DEMO-B
 * on Entry and buys it back on Exit.
 */
function crossoverRules(ids: Record<string, string>, accountId: string, pair: boolean) {
  const a = ids['DEMO-A']!;
  const b = ids['DEMO-B']!;
  const sma = (id: string) => ({
    kind: 'indicator',
    id,
    name: 'SMA',
    params: { period: 20 },
    ...series(a),
  });
  const px = (id: string) => ({ kind: 'market', id, ...series(a) });
  const trigger = { mode: 'on_transition', cooldownSec: 0, confirmationBars: 0 };
  return {
    entry: {
      condition: group('eg', {
        kind: 'comparison',
        id: 'in',
        operator: 'crosses_above',
        left: px('p1'),
        right: sma('s1'),
      }),
      trigger,
      orders: [
        leg('buy-a', 'Buy A', a, accountId, 'buy'),
        ...(pair ? [leg('short-b', 'Short B', b, accountId, 'sell_short')] : []),
      ],
    },
    exit: {
      condition: group('xg', {
        kind: 'comparison',
        id: 'out',
        operator: 'crosses_below',
        left: px('p2'),
        right: sma('s2'),
      }),
      trigger,
      orders: [
        leg('close-a', 'Close A', a, accountId, 'close'),
        ...(pair ? [leg('cover-b', 'Cover B', b, accountId, 'close')] : []),
      ],
    },
  };
}

/** Creates a strategy with valid crossover rules through the API and returns its detail. */
export async function createTestedStrategy(
  page: Page,
  baseURL: string,
  name: string,
  options: { pair?: boolean } = {},
) {
  const headers = { origin: baseURL };
  const created = await (
    await page.request.post('/api/v1/strategies', { data: { name }, headers })
  ).json();
  const ids = await instrumentIds(page, created.id);
  const base = await (await page.request.get(`/api/v1/strategies/${created.id}`)).json();
  const definition = {
    ...base.definition,
    ...crossoverRules(ids, created.defaultAccountId, options.pair ?? false),
  };
  const saved = await page.request.patch(`/api/v1/strategies/${created.id}`, {
    data: { rowVersion: base.rowVersion, definition },
    headers,
  });
  expect(saved.status()).toBe(200);
  return (await saved.json()) as { id: string; rowVersion: number; definitionHash: string };
}

/**
 * Creates a strategy whose rules come from `rules` (given the DEMO instrument
 * ids and the default paper account) and moves it to Under testing.
 */
export async function createStrategyWithRules(
  page: Page,
  baseURL: string,
  name: string,
  rules: (ids: Record<string, string>, accountId: string) => Record<string, unknown>,
) {
  const headers = { origin: baseURL };
  const created = await (
    await page.request.post('/api/v1/strategies', { data: { name }, headers })
  ).json();
  const ids = await instrumentIds(page, created.id);
  const base = await (await page.request.get(`/api/v1/strategies/${created.id}`)).json();
  const definition = { ...base.definition, ...rules(ids, created.defaultAccountId) };
  const saved = await page.request.patch(`/api/v1/strategies/${created.id}`, {
    data: { rowVersion: base.rowVersion, definition, status: 'under_testing' },
    headers,
  });
  expect(saved.status()).toBe(200);
  return (await saved.json()) as { id: string; rowVersion: number };
}
