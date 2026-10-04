import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { createTestedStrategy } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

test('run a back test on a pair strategy and read the results beside their assumptions', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('backtest'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Pair back test', { pair: true });
  await page.goto(`/strategy-lab/${strategy.id}`);

  const panel = page.getByRole('region', { name: 'Back Test', exact: true });
  await expect(panel.getByText('None yet')).toBeVisible();
  await panel.getByLabel('From').fill('2023-01-03');
  await panel.getByLabel('To').fill('2023-12-29');
  await expect(panel.getByLabel('Bars')).toHaveValue('1d');
  await panel.getByText('Costs and fills').click();
  await expect(panel.getByLabel('Slippage (basis points)')).toHaveValue('5');
  await panel.getByRole('button', { name: 'Run back test' }).click();

  // The run queues, the worker picks it up, and the results replace the progress line.
  const results = page.getByRole('region', { name: 'Back test results' });
  await expect(results.getByText('Completed')).toBeVisible({ timeout: 30_000 });
  await expect(
    results.getByText('Version 1 · Jan 3, 2023 to Dec 29, 2023 · Daily bars'),
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

  // Each cycle links Entry and Exit across both legs.
  const trades = results.getByRole('table', { name: 'Trades' });
  await expect(trades.getByRole('row').nth(1)).toContainText('Buy 20 DEMO-A');
  await expect(trades.getByRole('row').nth(1)).toContainText('Sell short 20 DEMO-B');
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

  // A bad range comes back as a field error, without leaving the page.
  await panel.getByLabel('Bars').selectOption('1h');
  await panel.getByLabel('From').fill('2021-01-04');
  await panel.getByRole('button', { name: 'Run back test' }).click();
  await expect(panel.getByText('Hourly back tests can cover at most 1 year')).toBeVisible();
});
