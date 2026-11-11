import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { createTestedStrategy } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

const SHOTS = process.env.E2E_SCREENSHOT_DIR;

test('back test a pair strategy, read the results beside their assumptions, and start through the gate', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('backtest'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Pair back test', { pair: true });
  await page.goto(`/strategy-lab/${strategy.id}`);

  const panel = page.getByRole('region', { name: 'Run a back test', exact: true });
  await expect(panel.getByText('None yet')).toBeVisible();
  // An end date and a period back from it (N229); the strategy sets the bars (N228).
  await expect(panel.getByLabel('End date')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(panel.getByLabel('Look back')).toHaveValue('1y');
  await panel.getByLabel('End date').fill('2023-12-29');
  await expect(panel.getByText('Dec 29, 2022 to Dec 29, 2023')).toBeVisible();
  await expect(panel.getByLabel('Bars')).toHaveCount(0);
  await expect(
    panel.getByText(/^Daily bars, set by the strategy's Check Entry, Check Exit and conditions\./),
  ).toBeVisible();
  // A pair is not a group: no instruments to narrow (N230).
  await expect(panel.getByRole('group', { name: 'Instruments to test' })).toHaveCount(0);
  await panel.getByText('Costs and fills').click();
  await expect(panel.getByLabel('Slippage (basis points)')).toHaveValue('5');
  await panel.getByRole('button', { name: 'Run back test' }).click();

  // The run queues, the worker picks it up, and the results replace the progress line.
  const results = page.getByRole('region', { name: 'Back test results' });
  await expect(results.getByText('Completed')).toBeVisible({ timeout: 30_000 });
  // The run summary is collapsed until opened (N170).
  await expect(results.getByText(/Engine engine@1/)).toBeHidden();
  await results.getByText('Run summary').click();
  await expect(
    results.getByText('Version 1 · Dec 29, 2022 to Dec 29, 2023 · Daily bars'),
  ).toBeVisible();
  await expect(results.getByText(/Engine engine@1 · Data demo-history@1/)).toBeVisible();

  for (const tile of [
    'Net return',
    'Gross return',
    'Max drawdown',
    'Win rate',
    'Profit factor',
    'Sharpe ratio',
    'Cycles',
    'Costs',
  ]) {
    await expect(
      results.getByRole('term').filter({ hasText: new RegExp(`^${tile}$`) }),
    ).toBeVisible();
  }
  await expect(results.getByRole('img', { name: /^Equity from \$100,000\.00 to/ })).toBeVisible();
  await expect(results.getByRole('img', { name: /^Gross exposure between/ })).toBeVisible();

  // One row per cycle (N157); opening it shows Entry beside Exit and each leg (N158, N159).
  const cycles = results.getByRole('table', { name: 'Cycles' });
  await expect(cycles.getByRole('row').nth(1)).toContainText('DEMO-A, DEMO-B');
  await cycles.getByRole('button', { name: 'Cycle 1', exact: true }).click();
  await expect(page).toHaveURL(/[?&]cycle=1\b/);
  const cycle = results.getByRole('region', { name: 'Cycle 1', exact: true });
  const cycleEntry = cycle.getByRole('list', { name: 'Entry orders' });
  await expect(cycleEntry.getByText('Buy 20 DEMO-A · Market · Day')).toBeVisible();
  await expect(cycleEntry.getByText('Sell short 20 DEMO-B · Market · Day')).toBeVisible();
  await expect(cycle.getByText(/^Enter when: .* close$/).first()).toBeVisible();
  await expect(cycle.getByText('crosses above').first()).toBeVisible();
  // Key data on each side: conditions, timing and execution (N169).
  const entryKey = cycle.getByRole('region', { name: 'Entry key data' });
  await expect(entryKey.getByText(/^\d+ bars?: true on \d+/)).toBeVisible();
  await expect(entryKey.getByText('Could fill from')).toBeVisible();
  await expect(entryKey.getByText(/^last close \$[\d,.]+ → filled 20 at/).first()).toBeVisible();
  await entryKey.getByText(/^Bars up to the signal/).click();
  await expect(entryKey.getByText('Fired: orders planned').first()).toBeVisible();
  const exitKey = cycle.getByRole('region', { name: 'Exit key data' });
  await expect(exitKey.getByText('While the position was open')).toBeVisible();
  const legs = cycle.getByRole('table', { name: 'Cycle 1: legs' });
  await expect(legs.getByRole('cell', { name: 'DEMO-A', exact: true })).toBeVisible();
  await expect(legs.getByRole('cell', { name: 'DEMO-B', exact: true })).toBeVisible();
  await expect(legs.getByRole('cell', { name: 'Cycle total' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cycle-card.png`, fullPage: true });
  await cycle.getByRole('button', { name: /^Cycle 2 →/ }).click();
  await expect(results.getByRole('region', { name: 'Cycle 2', exact: true })).toBeVisible();

  // The full logs are kept, collapsed (N164).
  await results.getByText('Rules and full logs').click();
  // Entry and Exit say what each condition found and what came of each order.
  const entry = results.getByRole('region', { name: 'Entry', exact: true });
  await expect(
    entry.getByText(/^Entry conditions were checked on \d+ bars: true on \d+/),
  ).toBeVisible();
  const entryChecks = entry.getByRole('table', { name: 'Entry conditions: each condition' });
  await expect(entryChecks.getByText('crosses above')).toBeVisible();
  await entry.getByText(/^Bar by bar/).click();
  await entry.getByLabel('Show').selectOption('fired');
  const entryBars = entry.getByRole('table', { name: 'Entry conditions: bar by bar' });
  await expect(entryBars.getByText('Fired: orders planned').first()).toBeVisible();
  const entryOrders = entry.getByRole('table', { name: 'Entry orders' });
  await expect(entryOrders.getByText('Buy 20 DEMO-A · Market · Day').first()).toBeVisible();
  await expect(entryOrders.getByText('Filled', { exact: true }).first()).toBeVisible();
  const exit = results.getByRole('region', { name: 'Exit', exact: true });
  await expect(exit.getByText(/while a position was open/)).toBeVisible();
  await expect(exit.getByRole('table', { name: 'Exit orders' })).toBeVisible();

  const contributions = results.getByRole('table', { name: 'Contribution by instrument' });
  await expect(contributions.getByRole('cell', { name: 'DEMO-A', exact: true })).toBeVisible();
  await expect(contributions.getByRole('cell', { name: 'DEMO-B', exact: true })).toBeVisible();

  // Assumptions sit beside the results (§7.3).
  const assumptions = results.getByRole('complementary', { name: 'Assumptions' });
  await expect(
    assumptions.getByText("Market orders fill at the next bar's open with 5 bps of slippage", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(assumptions.getByText('Results are estimates, not guarantees')).toBeVisible();
  await expect(assumptions.getByText(/Sharpe ratio: Mean daily return/)).toBeVisible();

  const download = results.getByRole('link', { name: 'Download trades (CSV)' });
  await expect(download).toHaveAttribute('href', /\/api\/v1\/backtests\/[0-9a-f-]+\/export$/);

  // The panel knows the draft is the tested version, and lists the run.
  await expect(panel.getByText('Matches the latest back test')).toBeVisible();
  const history = panel.getByRole('table', { name: 'Back test history' });
  await expect(history.getByRole('row')).toHaveCount(2);
  await expect(history.getByText('Showing')).toBeVisible();

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);

  // Every period fits daily bars (N229).
  await expect(panel.getByRole('option', { name: '5 years' })).toBeEnabled();

  // Validation picked up the finished run: no back-test warning remains.
  const validation = page.getByRole('region', { name: 'Validation' });
  await expect(
    validation.getByText('No problems found.').or(validation.getByText(/warnings? to acknowledge/)),
  ).toBeVisible();
  await expect(validation.getByText('This strategy has not been back tested')).toHaveCount(0);

  // Change the rules after testing: the gate says so before Start (§7.4).
  const current = await (await page.request.get(`/api/v1/strategies/${strategy.id}`)).json();
  const changed = structuredClone(current.definition);
  changed.risk.maxOrderNotional = '9000';
  const saved = await page.request.patch(`/api/v1/strategies/${strategy.id}`, {
    data: { rowVersion: current.rowVersion, definition: changed, status: 'under_testing' },
    headers: { origin: baseURL! },
  });
  expect(saved.status()).toBe(200);
  await page.reload();
  await expect(panel.getByText('Changed since the latest back test')).toBeVisible();
  await expect(
    validation.getByText('The strategy changed after its latest back test'),
  ).toBeVisible();

  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  await execution.getByRole('button', { name: 'Start execution' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start on paper?' });
  await expect(dialog.getByText('Latest back test', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/\(version 1\)$/)).toBeVisible();
  await expect(dialog.getByText('Changed since the latest back test')).toBeVisible();
  for (const box of await dialog.getByRole('checkbox').all()) await box.check();
  await dialog.getByRole('button', { name: 'Start on paper' }).click();
  await expect(execution.getByText('Status: Actively executing')).toBeVisible();
  const started = await (await page.request.get(`/api/v1/strategies/${strategy.id}`)).json();
  expect(started.statusHistory[0]).toMatchObject({
    toStatus: 'actively_executing',
    versionNo: 2,
  });
  expect(started.statusHistory[0].acknowledgedWarnings).toContain('stale_backtest');
});
