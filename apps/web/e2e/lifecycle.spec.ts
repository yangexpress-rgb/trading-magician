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

  // A new draft is checked straight away and can't start.
  const validation = page.getByRole('region', { name: 'Validation' });
  await expect(
    validation.getByRole('heading', { name: /problems? blocks? starting/ }),
  ).toBeVisible();
  await expect(validation.getByText('Entry conditions:').first()).toBeVisible();
  const backTest = page.getByRole('region', { name: 'Back Test', exact: true });
  await expect(backTest.getByRole('button', { name: 'Run back test' })).toBeDisabled();
  const start = backTest.getByRole('button', { name: 'Start execution' });
  await expect(start).toBeDisabled();
  await expect(start).toHaveAccessibleDescription(
    'Move this strategy to Under testing before starting it.',
  );

  // Define both phases: a pair entered together and exited together.
  for (const phase of ['Entry', 'Exit'] as const) {
    await page
      .getByRole('region', { name: `${phase} conditions` })
      .getByRole('button', { name: `Add condition to ${phase} conditions` })
      .click();
  }
  await addLeg(page, 'Entry', 1, { name: 'Long A', symbol: 'DEMO-A', side: 'Buy', quantity: '10' });
  await addLeg(page, 'Entry', 2, {
    name: 'Short B',
    symbol: 'DEMO-B',
    side: 'Sell short',
    quantity: '10',
  });
  await addLeg(page, 'Exit', 1, { name: 'Sell A', symbol: 'DEMO-A', side: 'Sell', quantity: '10' });
  const coverB = await addLeg(page, 'Exit', 2, {
    name: 'Cover B',
    symbol: 'DEMO-B',
    side: 'Buy to cover',
    quantity: '10',
  });
  await expect(
    validation.getByText('Showing results for the last saved draft', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(saveState(page)).toHaveText('All changes saved');

  // Saved draft re-validates: no blockers, the non-atomic warning remains.
  await expect(validation.getByRole('heading', { name: /block starting/ })).toHaveCount(0);
  await expect(validation.getByRole('heading', { name: /warnings? to acknowledge/ })).toBeVisible();

  // Created → Under testing → Created → Under testing.
  await backTest.getByRole('button', { name: 'Move to Under testing' }).click();
  await expect(backTest.getByText('Status: Under testing')).toBeVisible();
  await backTest.getByRole('button', { name: 'Move back to Created' }).click();
  await expect(backTest.getByText('Status: Created')).toBeVisible();
  await backTest.getByRole('button', { name: 'Move to Under testing' }).click();
  await expect(backTest.getByText('Status: Under testing')).toBeVisible();

  // Start sits right after Run back test, and asks for each warning to be acknowledged.
  const controls = backTest.getByRole('button');
  const names = await controls.allTextContents();
  expect(names.indexOf('Start execution')).toBe(names.indexOf('Run back test') + 1);
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
  await expect(backTest.getByText('Status: Actively executing')).toBeVisible();
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

  await backTest.getByRole('button', { name: 'Stop execution' }).click();
  const stop = page.getByRole('dialog', { name: 'Stop execution?' });
  await expect(stop.getByText('Working orders and positions are left as they are.')).toBeVisible();
  await stop.getByLabel('Reason (optional)').fill('End of test');
  await stop.getByRole('button', { name: 'Stop execution' }).click();
  await expect(backTest.getByText('Status: Off')).toBeVisible();
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
