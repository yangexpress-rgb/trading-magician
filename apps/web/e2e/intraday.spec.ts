import { expect } from '@playwright/test';
import { createTestedStrategy } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The intraday pack (N253–N256): Check Exit "Last" from the default state in
 * one step, the session values in the picker, Minutes held, and the
 * Flatten at session end toggle.
 */
test('Check Exit picks Last from the default state in one step (N256)', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('intraday'));
  const strategy = await createTestedStrategy(page, baseURL!, 'Intraday pack');
  await page.goto(`/strategy-lab/${strategy.id}`);

  // The default state: Exit is checked on every bar the run steps on (daily fallback).
  const checkExit = page.getByLabel('Check Exit');
  await expect(checkExit).toHaveValue('run');
  await expect(checkExit.locator('option[value="last"]')).toBeEnabled();
  await checkExit.selectOption('last');
  await expect(checkExit).toHaveValue('last');
  await expect(page.getByLabel('Exit bar size')).toHaveValue('5m');

  // Session values have their own Type, grouped as "Session (intraday)".
  const exit = page.getByRole('region', { name: 'Exit when' });
  const type = exit.getByRole('combobox', { name: 'Type' }).first();
  await type.selectOption('session');
  await expect(exit.getByLabel('Session value').first()).toHaveValue('session.vwap');
  await exit.getByLabel('Session value').first().selectOption('session.opening_high');
  await expect(exit.getByLabel('Opening range (minutes)').first()).toHaveValue('30');

  // Minutes held sits next to Trading days held among the Position values.
  await type.selectOption('position');
  const value = exit.getByRole('combobox', { name: 'Value' }).first();
  await value.selectOption('minutes_held');
  await expect(exit.getByText(/an intraday time stop/)).toBeVisible();

  // Flatten at session end is a cycle option.
  const flatten = page.getByLabel('Flatten at session end');
  await expect(flatten).not.toBeChecked();
  await flatten.check();
  await expect(flatten).toBeChecked();
});
