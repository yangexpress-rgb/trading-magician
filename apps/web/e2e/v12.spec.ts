import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { createTestedStrategy } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

const SHOTS = process.env.E2E_SCREENSHOT_DIR;

test('build a Selection group with a time stop, back test it, and read the ranking', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('selection'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Momentum rotation');
  await page.goto(`/strategy-lab/${strategy.id}`);

  // Entry becomes a Selection group: one leg on "each selected instrument".
  await page.getByLabel('Selection group: rank a universe and hold the top N').check();
  await expect(page.getByLabel('Universe', { exact: true })).toHaveValue('list');
  await expect(page.getByLabel('Rank by', { exact: true })).toHaveValue('return');
  await page.getByLabel('Lookback (months)').selectOption('3');
  await page.getByLabel('N', { exact: true }).fill('1');
  const entryLeg = page.getByRole('region', { name: /^Entry leg 1/ });
  await expect(entryLeg.getByLabel('Instrument')).toHaveValue(
    '00000000-0000-0000-0000-000000000000',
  );
  await expect(page.getByLabel('Evaluate Entry and re-selection')).toHaveValue('monthEnd');
  await expect(page.getByText(/each instrument is evaluated on its own/).first()).toBeVisible();
  // The rebalance is shown as an exit of its own (ADR 0049).
  await expect(
    page.getByText('Sells whatever leaves the top N at the next rebalance.', { exact: false }),
  ).toBeVisible();

  // The regime gate is the crossover from the fixture; clear it so every month-end rebalances.
  const entry = page.getByRole('region', { name: 'Regime gate' });
  while ((await entry.getByRole('button', { name: /^Remove condition/ }).count()) > 0) {
    await entry
      .getByRole('button', { name: /^Remove condition/ })
      .first()
      .click();
  }
  const exit = page.getByRole('region', { name: 'Exit condition' });
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

  const panel = page.getByRole('region', { name: 'Back Test', exact: true });
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
});

test('per-leg conditions, a z-score and a registry metric in the builder', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('legs'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Pair legs', { pair: true });
  await page.goto(`/strategy-lab/${strategy.id}`);

  const leg1 = page.getByRole('region', { name: /^Entry leg 1/ });
  await leg1.getByRole('button', { name: 'Add a condition for Entry leg 1' }).click();
  const legConditions = leg1.getByRole('region', { name: 'Entry leg 1 conditions' });
  await legConditions
    .getByRole('button', { name: 'Add condition to Entry leg 1 conditions' })
    .click();
  const left = legConditions.getByRole('group', { name: 'Left side', exact: true });
  await left
    .getByLabel('Type', { exact: true })
    .selectOption({ label: 'Statistic (std. dev., z-score, Bollinger, BandWidth)' });
  await expect(left.getByLabel('Function')).toHaveValue('ZSCORE');
  await left.getByLabel('Period (bars)').fill('60');
  await expect(left.getByLabel('Instrument').first()).toBeVisible();
  const right = legConditions.getByRole('group', { name: 'Right side', exact: true });
  await right
    .getByLabel('Type', { exact: true })
    .selectOption({ label: 'Metric (price-based, shared registry)' });
  await expect(right.getByLabel('Metric')).toHaveValue('return');
  await expect(right.getByLabel('Metric').locator('option', { hasText: 'RSI' })).toHaveCount(1);

  // "Only the best ones" is a Selection group of these legs (ADR 0049).
  await page.getByLabel('When several legs qualify').selectOption('best');
  await expect(page.getByLabel('Rank by', { exact: true })).toHaveValue('return');
  await expect(page.getByText('Universe: these Entry legs', { exact: false })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/per-leg-builder.png`, fullPage: true });
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(a11y.violations).toEqual([]);
});
