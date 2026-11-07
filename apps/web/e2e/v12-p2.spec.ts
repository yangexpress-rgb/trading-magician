import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Design v1.2 P2 in the browser: Highest / Lowest start one bar back
 * (item 7), and a strategy with a long and a short entry group (item 8).
 */

const SHOTS = process.env.E2E_SCREENSHOT_DIR;

const extreme = (
  id: string,
  name: string,
  field: string,
  period: number,
  instrumentId: string,
) => ({
  kind: 'indicator',
  id,
  name,
  params: { period },
  ...series(instrumentId),
  field,
  offset: 1,
});
const close = (id: string, instrumentId: string) => ({
  kind: 'market',
  id,
  ...series(instrumentId),
});
const trigger = { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 };

/** Long a 20-day breakout of DEMO-A, out below the 10-day low. */
const longBreakout = (a: string, accountId: string) => ({
  entry: {
    direction: 'long',
    condition: group('eg', {
      kind: 'comparison',
      id: 'up',
      operator: 'gt',
      left: close('p1', a),
      right: extreme('h20', 'HIGHEST', 'high', 20, a),
    }),
    trigger,
    orders: [leg('buy-a', 'Buy A', a, accountId, 'buy')],
  },
  exit: {
    condition: group('xg', {
      kind: 'comparison',
      id: 'down10',
      operator: 'lt',
      left: close('p2', a),
      right: extreme('l10', 'LOWEST', 'low', 10, a),
    }),
    trigger,
    orders: [leg('sell-a', 'Sell A', a, accountId, 'close')],
  },
});

test('Highest starts one bar back, with help on which bars count', async ({ page, baseURL }) => {
  await signUpAndVerify(page, uniqueEmail('highest'));
  const s = await createStrategyWithRules(page, baseURL!, 'Breakout', (ids, account) =>
    longBreakout(ids['DEMO-A']!, account),
  );
  await page.goto(`/strategy-lab/${s.id}`);
  const entry = page.getByRole('region', { name: 'Entry conditions' });
  // The saved rule reads one bar back, and says why, with its own period.
  await expect(
    entry.getByText(/Highest value\(20\) of high" means a close above the previous 20 bars'/),
  ).toBeVisible();
  // Picking Highest anew on the left side also starts at Bars ago 1.
  await entry.getByLabel('Type', { exact: true }).first().selectOption('indicator');
  await entry.getByLabel('Indicator', { exact: true }).first().selectOption('HIGHEST');
  await expect(entry.getByLabel('Bars ago').first()).toHaveValue('1');
});

test('a long and a short entry group: built, validated, back tested with directions', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await signUpAndVerify(page, uniqueEmail('two-sided'));
  const headers = { origin: baseURL! };
  const s = await createStrategyWithRules(page, baseURL!, 'Two-sided breakout', (ids, account) =>
    longBreakout(ids['DEMO-A']!, account),
  );

  // Add a group in the builder: short, its Entry leg sells short and its Exit covers.
  await page.goto(`/strategy-lab/${s.id}`);
  await page.getByRole('button', { name: 'Add an entry group' }).click();
  const g2 = page.getByRole('region', { name: 'Entry group 2: Group 2' });
  await expect(g2.getByLabel('Direction')).toHaveValue('short');
  await expect(
    g2.getByRole('region', { name: /^Entry leg 1/ }).getByLabel('Side', { exact: true }),
  ).toHaveValue('sell_short');
  await expect(
    g2.getByRole('region', { name: /^Exit leg 1/ }).getByLabel('Side', { exact: true }),
  ).toHaveValue('buy_to_cover');
  await g2.getByLabel('Entry group 2 name').fill('Short breakdown');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  // Its conditions are still empty: validation names the group.
  const v1 = await (
    await page.request.post(`/api/v1/strategies/${s.id}/validate`, { headers })
  ).json();
  expect(v1.errors.map((e: { path: unknown[] }) => e.path.slice(0, 2))).toContainEqual([
    'groups',
    0,
  ]);
  await expect(page.getByText(/Short breakdown: Entry/).first()).toBeVisible({ timeout: 15_000 });

  // Fill the short group's conditions (as the builder would) and back test.
  const current = await (await page.request.get(`/api/v1/strategies/${s.id}`)).json();
  const a = current.definition.entry.orders[0].instrumentId as string;
  const def = structuredClone(current.definition);
  def.groups[0].entry.condition = group('sg', {
    kind: 'comparison',
    id: 'dn',
    operator: 'lt',
    left: close('p3', a),
    right: extreme('l20', 'LOWEST', 'low', 20, a),
  });
  def.groups[0].exit.condition = group('sx', {
    kind: 'comparison',
    id: 'up10',
    operator: 'gt',
    left: close('p4', a),
    right: extreme('h10', 'HIGHEST', 'high', 10, a),
  });
  const saved = await page.request.patch(`/api/v1/strategies/${s.id}`, {
    data: { rowVersion: current.rowVersion, definition: def },
    headers,
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const v2 = await (
    await page.request.post(`/api/v1/strategies/${s.id}/validate`, { headers })
  ).json();
  expect(v2.errors).toEqual([]);

  const queued = await page.request.post(`/api/v1/strategies/${s.id}/backtests`, {
    data: { from: '2023-01-03', to: '2024-12-31' },
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
  const { trades } = (await (
    await page.request.get(`/api/v1/backtests/${run.id}/trades`)
  ).json()) as { trades: { direction?: string; group?: string }[] };
  expect(trades.length).toBeGreaterThan(0);
  for (const t of trades) expect(['long', 'short']).toContain(t.direction);
  expect(new Set(trades.map((t) => t.group))).toEqual(
    new Set(trades.map((t) => (t.direction === 'long' ? 'Group 1' : 'Short breakdown'))),
  );

  // The builder shows both groups; the result's trade list shows each direction.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Entry group 2: Short breakdown' })).toBeVisible();
  const results = page.getByRole('region', { name: 'Back test results' });
  await expect(
    results.getByRole('table', { name: 'Trades' }).getByRole('columnheader', { name: 'Direction' }),
  ).toBeVisible({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/entry-groups.png`, fullPage: true });
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
});

test('an entry group can be removed again', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await signUpAndVerify(page, uniqueEmail('remove-group'));
  const s = await createStrategyWithRules(page, baseURL!, 'Removable group', (ids, account) =>
    longBreakout(ids['DEMO-A']!, account),
  );
  await page.goto(`/strategy-lab/${s.id}`);
  await page.getByRole('button', { name: 'Add an entry group' }).click();
  const g2 = page.getByRole('region', { name: 'Entry group 2: Group 2' });
  await expect(g2).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  // Confirmed on the page, never in a browser dialog (which some browsers block).
  page.on('dialog', () => {
    throw new Error('Remove group must not open a browser dialog');
  });
  await g2.getByRole('button', { name: 'Remove group' }).click();
  await g2.getByRole('button', { name: 'Keep it' }).click();
  await expect(g2).toBeVisible();
  await g2.getByRole('button', { name: 'Remove group' }).click();
  await g2.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(g2).toHaveCount(0);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Add an entry group' })).toBeVisible();
  await expect(page.getByRole('region', { name: /^Entry group 2/ })).toHaveCount(0);
});

test('risk % of equity sized from ATR, with an ATR stop, explained per trade', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await signUpAndVerify(page, uniqueEmail('risk-atr'));
  const headers = { origin: baseURL! };
  const s = await createStrategyWithRules(page, baseURL!, 'ATR-sized breakout', (ids, account) =>
    longBreakout(ids['DEMO-A']!, account),
  );

  // In the builder: Entry leg 1 risks 1% of equity with the stop 1 ATR(20) away,
  // and the Exit gets an ATR stop at the same distance.
  await page.goto(`/strategy-lab/${s.id}`);
  const entryLeg = page.getByRole('region', { name: /^Entry leg 1/ }).first();
  await entryLeg.getByLabel('Quantity in').selectOption('risk_atr');
  await expect(entryLeg.getByLabel('Risk (% of equity)')).toHaveValue('1');
  await expect(entryLeg.getByLabel('ATR period (daily bars)')).toHaveValue('20');
  await entryLeg.getByLabel('Stop distance (ATRs)').fill('1');
  await page.getByRole('button', { name: 'Add an ATR stop' }).click();
  await page.getByLabel('ATR stop: ATRs from the entry price').fill('1');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  const v = await (
    await page.request.post(`/api/v1/strategies/${s.id}/validate`, { headers })
  ).json();
  expect(v.errors).toEqual([]);

  const queued = await page.request.post(`/api/v1/strategies/${s.id}/backtests`, {
    data: { from: '2023-01-03', to: '2024-12-31' },
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
  type Trade = {
    exitReason?: string;
    legs: { phase: string; quantity: string }[];
    sizing?: {
      equity: string;
      riskPct: string;
      atr: string;
      atrMultiple: string;
      stopDistance: string;
      riskQuantity: string;
      quantity: string;
      cappedBy?: string;
    };
    atrStop?: { atr: string; entryPrice: string; level: string };
  };
  const { trades } = (await (
    await page.request.get(`/api/v1/backtests/${run.id}/trades`)
  ).json()) as { trades: Trade[] };
  expect(trades.length).toBeGreaterThan(0);
  // Each trade's quantity checks by hand from what it shows.
  for (const t of trades) {
    const z = t.sizing!;
    expect(Number(z.stopDistance)).toBeCloseTo(Number(z.atr) * Number(z.atrMultiple), 8);
    expect(Number(z.riskQuantity)).toBe(
      Math.floor((Number(z.equity) * Number(z.riskPct)) / 100 / Number(z.stopDistance)),
    );
    const entryQty = t.legs.find((l) => l.phase === 'entry')?.quantity;
    if (entryQty) expect(Number(entryQty)).toBe(Number(z.quantity));
    if (!z.cappedBy) expect(z.quantity).toBe(z.riskQuantity);
  }
  const stopped = trades.filter((t) => t.exitReason === 'atr_stop');
  expect(stopped.length).toBeGreaterThan(0);
  for (const t of stopped) {
    expect(Number(t.atrStop!.level)).toBeCloseTo(
      Number(t.atrStop!.entryPrice) - Number(t.atrStop!.atr),
      3,
    );
  }

  // The trade list explains the sizing and labels the ATR stop.
  await page.reload();
  const table = page
    .getByRole('region', { name: 'Back test results' })
    .getByRole('table', { name: 'Trades' });
  await expect(table.getByRole('columnheader', { name: 'Sizing' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(table.getByText('ATR stop', { exact: true }).first()).toBeVisible();
  await expect(table.getByText(/^Risk 1% of \$[\d,.]+ equity = /).first()).toBeVisible();
  await expect(
    table.getByText(/^Stop [\d.]+ = entry [\d.]+ − 1 × ATR [\d.]+$/).first(),
  ).toBeVisible();
  const csv = await (await page.request.get(`/api/v1/backtests/${run.id}/export`)).text();
  expect(csv.split('\r\n')[0]).toContain('risk_pct,atr_period,atr_at_entry');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/risk-atr.png`, fullPage: true });
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
});
