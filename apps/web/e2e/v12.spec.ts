import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import {
  createStrategyWithRules,
  createTestedStrategy,
  group,
  leg,
  series,
} from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

const SHOTS = process.env.E2E_SCREENSHOT_DIR;

test('build a group with a time stop, back test it, and read the ranking', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('selection'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Momentum rotation');
  await page.goto(`/strategy-lab/${strategy.id}`);

  // What to trade becomes a group (ADR 0073): one Entry leg buys each pick.
  await page.getByLabel('A group: filter and rank its members').check();
  await expect(page.getByLabel('Members', { exact: true })).toHaveValue('list');
  await expect(page.getByLabel('Rank by', { exact: true })).toHaveValue('return');
  await page.getByLabel('Lookback (months)').selectOption('3');
  await page.getByLabel('N', { exact: true }).fill('1');
  const entryLeg = page.getByRole('region', { name: /^Entry leg 1/ });
  await expect(entryLeg.getByLabel('Instrument')).toHaveValue(
    '00000000-0000-0000-0000-000000000000',
  );
  await expect(page.getByLabel('Check Entry')).toHaveValue('monthEnd');
  // A month-end Entry checks Exit once a day (O145).
  await expect(page.getByLabel('Check Exit')).toHaveValue('daily');
  await expect(page.getByText(/each instrument is evaluated on its own/).first()).toBeVisible();
  // Selling what leaves the top N is an exit rule of its own.
  await expect(page.getByText('Left the group', { exact: true })).toBeVisible();

  // Enter when is the crossover from the fixture; clear it so every month-end rebalances.
  const entry = page.getByRole('region', { name: 'Enter when' });
  while ((await entry.getByRole('button', { name: /^Remove condition/ }).count()) > 0) {
    await entry
      .getByRole('button', { name: /^Remove condition/ })
      .first()
      .click();
  }
  const exit = page.getByRole('region', { name: 'Exit when' });
  while ((await exit.getByRole('button', { name: /^Remove condition/ }).count()) > 0) {
    await exit
      .getByRole('button', { name: /^Remove condition/ })
      .first()
      .click();
  }

  // A time stop sits in the Exit rules.
  await page.getByRole('button', { name: 'Add a holding-period exit' }).click();
  await page.getByLabel('Holding-period exit: trading days held').fill('15');

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/selection-builder.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);

  const panel = page.getByRole('region', { name: 'Run a back test', exact: true });
  await panel.getByLabel('From').fill('2023-01-03');
  await panel.getByLabel('To').fill('2023-12-29');
  await panel.getByRole('button', { name: 'Run back test' }).click();
  const results = page.getByRole('region', { name: 'Back test results' });
  await expect(results.getByText('Completed')).toBeVisible({ timeout: 60_000 });

  await results.getByText('Rules and full logs').click();
  await expect(results.getByRole('heading', { name: 'Selection rounds' })).toBeVisible();
  await expect(results.getByText(/Ranked by Return \(lookback \(months\) 3/)).toBeVisible();
  const table = results.getByRole('table', { name: /^Round of/ });
  await expect(table.getByRole('columnheader', { name: 'Rank' })).toBeVisible();
  await expect(table.locator('tbody tr').first()).toBeVisible();
  await expect(results.getByRole('button', { name: 'Download all rounds (CSV)' })).toBeVisible();
  // Each trade says why it exited.
  await expect(results.getByText(/Rebalance: no longer selected|Time stop/).first()).toBeVisible();
  if (SHOTS) await results.screenshot({ path: `${SHOTS}/selection-results.png` });

  // The cycle card follows the strategy's three parts (N219, N220).
  await results
    .getByRole('table', { name: 'Cycles' })
    .getByRole('button', { name: 'Cycle 1', exact: true })
    .click();
  const cycle = results.getByRole('region', { name: 'Cycle 1', exact: true });
  const trade = cycle.getByRole('group', { name: 'What to trade' });
  await expect(trade.getByText('Members checked')).toBeVisible();
  await expect(trade.getByText(/^1 of \d+ ranked · top 1 kept$/)).toBeVisible();
  await expect(trade.getByText('No filter: every member was a candidate.')).toBeVisible();
  await expect(
    cycle.getByRole('group', { name: 'Entry' }).getByText('Last trading day of each month'),
  ).toBeVisible();
  await expect(
    cycle.getByRole('group', { name: 'Exit' }).getByText('Once a day, after the close'),
  ).toBeVisible();
  if (SHOTS) await cycle.screenshot({ path: `${SHOTS}/selection-cycle-card.png` });
});

test('a z-score and a registry metric in Enter when; no new per-leg conditions', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('legs'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Pair legs', { pair: true });
  await page.goto(`/strategy-lab/${strategy.id}`);

  // Per-leg conditions left the builder (ADR 0073, O148).
  const leg1 = page.getByRole('region', { name: /^Entry leg 1/ });
  await expect(leg1.getByRole('button', { name: 'Add a condition for Entry leg 1' })).toHaveCount(
    0,
  );
  await expect(page.getByLabel('When several legs qualify')).toHaveCount(0);

  const entry = page.getByRole('region', { name: 'Enter when' });
  await entry.getByRole('button', { name: 'Add condition to Enter when' }).click();
  const condition = entry.getByRole('group', { name: 'Left side', exact: true }).last();
  await condition
    .getByLabel('Type', { exact: true })
    .selectOption({ label: 'Statistic (std. dev., z-score, Bollinger, BandWidth)' });
  await expect(condition.getByLabel('Function')).toHaveValue('ZSCORE');
  await condition.getByLabel('Period (bars)').fill('60');
  await expect(condition.getByLabel('Instrument').first()).toBeVisible();
  const right = entry.getByRole('group', { name: 'Right side', exact: true }).last();
  await right
    .getByLabel('Type', { exact: true })
    .selectOption({ label: 'Metric (price-based, shared registry)' });
  await expect(right.getByLabel('Metric')).toHaveValue('return');
  await expect(right.getByLabel('Metric').locator('option', { hasText: 'RSI' })).toHaveCount(1);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/per-leg-builder.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
});

test('a filtered group explains each pick: filter values, ranking, Enter when for the stock', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('pick-why'));
  const C = '00000000-0000-0000-0000-000000000000';
  const close = (id: string, offset = 0) => ({ kind: 'market', id, ...series(C), offset });
  const strategy = await createStrategyWithRules(
    page,
    baseURL!,
    'Up-day picks',
    (ids, account) => ({
      trade: {
        kind: 'group',
        universe: { type: 'list', instrumentIds: Object.values(ids).slice(0, 5) },
        filter: {
          kind: 'group',
          id: 'f',
          op: 'and',
          negate: false,
          children: [
            {
              kind: 'comparison',
              id: 'up',
              operator: 'gte',
              left: close('now'),
              right: {
                kind: 'calc',
                id: 'times',
                op: 'mul',
                args: [close('prev', 1), { kind: 'constant', id: 'k', value: '1.001' }],
              },
            },
          ],
        },
        ranking: {
          metric: 'return',
          params: { lookbackMonths: '1', skipMonths: '0' },
          direction: 'desc',
          count: { type: 'fixed', value: 2 },
        },
      },
      entry: {
        schedule: { frequency: 'daily' },
        condition: group('eg', {
          kind: 'comparison',
          id: 'above',
          operator: 'gt',
          left: close('p'),
          right: { kind: 'indicator', id: 'sma', name: 'SMA', params: { period: 5 }, ...series(C) },
        }),
        trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
        orders: [
          {
            ...leg('buy-each', 'Buy each pick', C, account, 'buy'),
            quantity: { type: 'notional', value: '2000', rounding: 'down' },
          },
        ],
      },
      exit: {
        // A 1% trailing stop, in Exit when (ADR 0074).
        condition: group('xg', {
          kind: 'comparison',
          id: 'trail',
          operator: 'gt',
          left: { kind: 'position', id: 'off', ...series(C), field: 'off_peak_pct' },
          right: { kind: 'constant', id: 'one', value: '1' },
        }),
        orders: [leg('close-each', 'Close each pick', C, account, 'close')],
      },
    }),
  );
  await page.goto(`/strategy-lab/${strategy.id}`);
  const panel = page.getByRole('region', { name: 'Run a back test', exact: true });
  await panel.getByLabel('From').fill('2023-01-03');
  await panel.getByLabel('To').fill('2023-06-30');
  await panel.getByRole('button', { name: 'Run back test' }).click();
  const results = page.getByRole('region', { name: 'Back test results' });
  await expect(results.getByText('Completed')).toBeVisible({ timeout: 60_000 });
  await results
    .getByRole('table', { name: 'Cycles' })
    .getByRole('button', { name: 'Cycle 1', exact: true })
    .click();
  const cycle = results.getByRole('region', { name: 'Cycle 1', exact: true });
  const trade = cycle.getByRole('group', { name: 'What to trade' });
  await expect(trade.getByText(/^Filter: passed by \d+ of 5$/)).toBeVisible();
  // The calculated side shows the close it multiplied, and why the filter held (N218).
  await expect(trade.getByText(/this instrument close 1 bars? ago$/).first()).toBeVisible();
  await expect(trade.getByText(/^[\d,.]+ ≥ [\d,.]+$/)).toBeVisible();
  await expect(trade.getByText(/ ranked · top 2 kept$/)).toBeVisible();
  const entry = cycle.getByRole('group', { name: 'Entry' });
  await expect(entry.getByText(/^Enter when, for DEMO-/)).toBeVisible();
  await expect(entry.getByText(/^[\d,.]+ > [\d,.]+$/)).toBeVisible();
  const exit = cycle.getByRole('group', { name: 'Exit' });
  await expect(exit.getByText('Check Exit:')).toBeVisible();
  await expect(exit.getByText(/^[\d,.]+ > 1$/)).toBeVisible();
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
  if (SHOTS) await cycle.screenshot({ path: `${SHOTS}/pick-cycle-card.png` });
});
