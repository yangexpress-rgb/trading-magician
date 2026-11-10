import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

async function selectByText(select: Locator, text: string) {
  const label = await select.locator('option', { hasText: text }).first().textContent();
  await select.selectOption({ label: label! });
}

async function addLeg(
  page: Page,
  phase: 'Entry' | 'Exit',
  n: number,
  leg: { name: string; symbol: string; side: string; quantity: string },
) {
  await page.getByRole('button', { name: `+ Add ${phase} order` }).click();
  const row = page.getByRole('region', { name: `${phase} leg ${n}`, exact: true });
  await row.getByLabel('Leg name').fill(leg.name);
  await selectByText(row.getByLabel('Instrument', { exact: true }), `${leg.symbol} ·`);
  await row.getByLabel('Side').selectOption({ label: leg.side });
  await row.getByLabel('Quantity', { exact: true }).fill(leg.quantity);
  return row;
}

async function expectNoSeriousA11yIssues(page: Page) {
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const saveState = (page: Page) => page.locator('#save-state');

test('define, validate, test, start on paper, stop, revise and review versions', async ({
  page,
}) => {
  await signUpAndVerify(page, uniqueEmail('lifecycle'));

  // Create from the library.
  await page.getByRole('button', { name: 'New strategy' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Pairs lifecycle');
  await page.getByRole('button', { name: 'Create strategy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Pairs lifecycle' })).toBeVisible();
  const id = page.url().split('/').pop()!;

  // Three sections in order, each holding its own cards (N171).
  const sections = page.getByRole('navigation', { name: 'Sections' }).getByRole('link');
  await expect(sections).toHaveText([/Strategy/, /Back test/, /Execution/]);
  const strategySection = page.getByRole('region', { name: 'Strategy', exact: true });
  for (const card of ['Order handling', 'Risk limits', 'Validation']) {
    await expect(strategySection.getByRole('region', { name: card })).toBeVisible();
  }
  // The theory is under the name, not in a Library entry card (N192).
  await expect(page.getByRole('region', { name: 'Library entry' })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Back test', exact: true })
      .getByRole('region', { name: 'Run a back test' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Execution', exact: true })
      .getByRole('region', { name: 'Versions and status history' }),
  ).toBeVisible();

  // A new draft is checked straight away and can't start.
  const validation = page.getByRole('region', { name: 'Validation' });
  await expect(
    validation.getByRole('heading', { name: /problems? blocks? starting/ }),
  ).toBeVisible();
  await expect(validation.getByText('Entry conditions:').first()).toBeVisible();
  const backTest = page.getByRole('region', { name: 'Run a back test', exact: true });
  await expect(backTest.getByRole('button', { name: 'Run back test' })).toBeDisabled();
  const execution = page.getByRole('region', { name: 'Execution', exact: true });
  const start = execution.getByRole('button', { name: 'Start execution' });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAccessibleDescription(
    'Move this strategy to Under testing before starting it.',
  );

  // Define both phases: a pair entered together and exited together.
  for (const region of ['Enter when', 'Exit when'] as const) {
    await page
      .getByRole('region', { name: region })
      .getByRole('button', { name: `Add condition to ${region}` })
      .click();
  }
  await addLeg(page, 'Entry', 1, { name: 'Long A', symbol: 'DEMO-A', side: 'Buy', quantity: '10' });
  await addLeg(page, 'Entry', 2, {
    name: 'Short B',
    symbol: 'DEMO-B',
    side: 'Sell short',
    quantity: '10',
  });
  // Exit is pre-filled with the opposite legs; only the names change here, by hand.
  await page.getByLabel('Mirror Entry legs').uncheck();
  const sellA = page.getByRole('region', { name: 'Exit leg 1', exact: true });
  await expect(sellA.getByLabel('Side')).toHaveValue('sell');
  await sellA.getByLabel('Leg name').fill('Sell A');
  const coverB = page.getByRole('region', { name: 'Exit leg 2', exact: true });
  await expect(coverB.getByLabel('Side')).toHaveValue('buy_to_cover');
  await coverB.getByLabel('Leg name').fill('Cover B');
  await expect(
    validation.getByText('Showing results for the last saved draft', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(saveState(page)).toHaveText('All changes saved');

  // Saved draft re-validates: no blockers, the non-atomic warning remains.
  await expect(validation.getByRole('heading', { name: /block starting/ })).toHaveCount(0);
  await expect(validation.getByRole('heading', { name: /warnings? to acknowledge/ })).toBeVisible();

  // Created → Under testing → Created → Under testing.
  await execution.getByRole('button', { name: 'Move to Under testing' }).click();
  await expect(execution.getByText('Status: Under testing')).toBeVisible();
  await execution.getByRole('button', { name: 'Move back to Created' }).click();
  await expect(execution.getByText('Status: Created')).toBeVisible();
  await execution.getByRole('button', { name: 'Move to Under testing' }).click();
  await expect(execution.getByText('Status: Under testing')).toBeVisible();

  // Start lives in the Execution section, not with the back test (N176), and asks for
  // each warning to be acknowledged.
  await expect(backTest.getByRole('button', { name: 'Start execution' })).toHaveCount(0);
  const ready = execution.getByRole('list', { name: 'Before starting' });
  await expect(ready).toContainText('Status is Under testing');
  await expect(ready).toContainText('Not back tested yet');
  await expect(start).toBeEnabled();
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Start on paper?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Paper (simulated orders, no real money)')).toBeVisible();
  await expect(dialog.getByText('DEMO-A, DEMO-B')).toBeVisible();
  await expect(dialog.getByText('2 Entry, 2 Exit')).toBeVisible();
  // The activation gate (§7.4): never back tested is a warning to acknowledge on paper.
  await expect(dialog.getByText('None yet')).toBeVisible();
  await expect(dialog.getByText('This strategy has not been back tested')).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Start on paper' });
  await expect(confirm).toBeDisabled();
  await expectNoSeriousA11yIssues(page);
  for (const box of await dialog.getByRole('checkbox').all()) await box.check();
  await confirm.click();
  await expect(dialog).toBeHidden();

  // Running: rules are read-only, version 1 is pinned, Stop is easy to reach.
  await expect(execution.getByText('Status: Actively executing')).toBeVisible();
  await expect(page.getByText('This strategy is running on paper.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft' })).toHaveCount(0);
  await expect(coverB.getByLabel('Leg name')).toBeDisabled();
  const versions = page.getByRole('region', { name: 'Versions' });
  await expect(versions.getByRole('link', { name: 'Version 1' })).toBeVisible();
  const history = await (await page.request.get(`/api/v1/strategies/${id}`)).json();
  expect(
    history.statusHistory.find((h: { toStatus: string }) => h.toStatus === 'actively_executing'),
  ).toMatchObject({
    versionNo: 1,
    acknowledgedWarnings: ['non_atomic_multi_leg', 'no_backtest'],
  });

  await execution.getByRole('button', { name: 'Stop execution' }).click();
  const stop = page.getByRole('dialog', { name: 'Stop execution?' });
  await expect(stop.getByText('Working orders and positions are left as they are.')).toBeVisible();
  await stop.getByLabel('Reason (optional)').fill('End of test');
  await stop.getByRole('button', { name: 'Stop execution' }).click();
  await expect(execution.getByText('Status: Off')).toBeVisible();
  await expect(versions.getByText('End of test')).toBeVisible();

  // After a strategy has run, saved rule changes become a new version.
  await coverB.getByLabel('Quantity', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(saveState(page)).toHaveText('All changes saved');
  await expect(versions.getByRole('link', { name: 'Version 2' })).toBeVisible();
  await expect(versions.getByText('(current)')).toHaveCount(1);
  await expectNoSeriousA11yIssues(page);

  // Version 1 still shows exactly what ran.
  await versions.getByRole('link', { name: 'Version 1' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pairs lifecycle · version 1' }),
  ).toBeVisible();
  await expect(page.getByText('Differs from the draft')).toBeVisible();
  await expect(page.getByText('Buy to cover 10 DEMO-B · Market · Day')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Started with this version' }).getByRole('listitem'),
  ).toHaveCount(1);
  await expectNoSeriousA11yIssues(page);

  await page.getByRole('link', { name: '← Back to Pairs lifecycle' }).click();
  await versions.getByRole('link', { name: 'Version 2' }).click();
  await expect(page.getByText('Same as the draft')).toBeVisible();
  await expect(page.getByText('Buy to cover 5 DEMO-B · Market · Day')).toBeVisible();
});
