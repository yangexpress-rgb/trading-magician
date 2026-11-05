import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

async function newStrategy(page: Page, baseURL: string, name: string): Promise<string> {
  const res = await page.request.post('/api/v1/strategies', {
    data: { name },
    headers: { origin: baseURL },
  });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/strategy-lab/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return id;
}

const side = (condition: Locator, name: string) =>
  condition.getByRole('group', { name, exact: true });

async function setSide(
  condition: Locator,
  name: string,
  value: { type: string; indicator?: string; period?: string; instrument?: string; value?: string },
) {
  const s = side(condition, name);
  await s.getByLabel('Type', { exact: true }).selectOption({ label: value.type });
  if (value.indicator) await s.getByLabel('Indicator').selectOption({ label: value.indicator });
  if (value.instrument) {
    const select = s.getByLabel('Instrument');
    const label = await select
      .locator('option', { hasText: `${value.instrument} ·` })
      .first()
      .textContent();
    await select.selectOption({ label: label! });
  }
  if (value.period) await s.getByLabel('Period').fill(value.period);
  if (value.value !== undefined) await s.getByLabel('Value', { exact: true }).fill(value.value);
}

async function instrumentOption(page: Page, symbol: string) {
  return page
    .getByRole('group', { name: 'Left side', exact: true })
    .first()
    .getByLabel('Instrument')
    .locator('option', { hasText: `${symbol} ·` })
    .first()
    .textContent();
}

test('SMA(30, DEMO-A) < SMA(30, DEMO-B) saves, reloads and validates identically', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('editor'));
  const id = await newStrategy(page, baseURL!, 'Beverage spread');

  const entry = page.getByRole('region', { name: 'Entry conditions' });
  await expect(entry.getByText('No conditions yet')).toBeVisible();
  await entry.getByRole('button', { name: 'Add condition to Entry conditions' }).click();
  const c1 = entry.getByRole('group', { name: 'Condition 1', exact: true });

  const a = await instrumentOption(page, 'DEMO-A');
  const b = await instrumentOption(page, 'DEMO-B');
  for (const [name, label] of [
    ['Left side', a],
    ['Right side', b],
  ] as const) {
    const s = side(c1, name);
    await s.getByLabel('Type', { exact: true }).selectOption({ label: 'Indicator' });
    await s.getByLabel('Indicator').selectOption({ label: 'Simple moving average (SMA)' });
    await s.getByLabel('Instrument').selectOption({ label: label! });
    await s.getByLabel('Period').fill('30');
  }
  await c1.getByLabel('Comparison').selectOption({ label: 'is less than (<)' });

  const readsAs = entry.locator('p').filter({ hasText: /^Reads as:/ });
  const expected = 'SMA(30) of DEMO-A close < SMA(30) of DEMO-B close';
  await expect(readsAs).toHaveText(`Reads as: ${expected}`);
  await expect(page.locator('#save-state')).toHaveText('Unsaved changes');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  const fetchState = async () => {
    const strategy = await (await page.request.get(`/api/v1/strategies/${id}`)).json();
    const validation = await (
      await page.request.post(`/api/v1/strategies/${id}/validate`, {
        headers: { origin: baseURL! },
      })
    ).json();
    return { definition: strategy.definition, validation };
  };
  const before = await fetchState();
  const saved = before.definition.entry.condition.children[0];
  expect(saved).toMatchObject({
    kind: 'comparison',
    operator: 'lt',
    left: { kind: 'indicator', name: 'SMA', params: { period: 30 }, field: 'close' },
    right: { kind: 'indicator', name: 'SMA', params: { period: 30 }, field: 'close' },
  });
  expect(saved.left.instrumentId).not.toBe(saved.right.instrumentId);
  // Each side carries its own instrument; the indicator condition passes validation.
  expect(
    before.validation.errors.filter((e: { path: unknown[] }) =>
      String(e.path).includes('children'),
    ),
  ).toEqual([]);

  await page.reload();
  await expect(readsAs).toHaveText(`Reads as: ${expected}`);
  await expect(side(c1, 'Left side').getByLabel('Period')).toHaveValue('30');
  await expect(
    side(c1, 'Right side').getByLabel('Instrument').locator('option:checked'),
  ).toHaveText(b!);
  await expect(page.locator('#save-state')).toHaveText('No unsaved changes');
  await expect(page.getByRole('button', { name: 'Save draft' })).toBeDisabled();

  const after = await fetchState();
  expect(after.definition).toEqual(before.definition);
  expect(after.validation).toEqual(before.validation);

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});

test('builds nested AND/OR/NOT groups with add, reorder, duplicate and remove', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('groups'));
  await newStrategy(page, baseURL!, 'Grouping');
  const exit = page.getByRole('region', { name: 'Exit conditions' });
  const add = exit.getByRole('button', { name: 'Add condition to Exit conditions' });

  await add.click();
  await add.click();
  await setSide(exit.getByRole('group', { name: 'Condition 1', exact: true }), 'Right side', {
    type: 'Fixed value',
    value: '10',
  });
  await setSide(exit.getByRole('group', { name: 'Condition 2', exact: true }), 'Right side', {
    type: 'Fixed value',
    value: '20',
  });

  // Reorder: condition 2 moves to the top.
  await exit.getByRole('button', { name: 'Move condition 2 up' }).click();
  const readsAs = exit.locator('p').filter({ hasText: /^Reads as:/ });
  await expect(readsAs).toContainText('> 20 AND');

  // A nested OR group, negated, with a duplicated condition.
  await exit.getByRole('button', { name: 'Add group to Exit conditions' }).click();
  const group = exit.getByRole('region', { name: 'Group 3' });
  await group.getByLabel('NOT: qualify when this group is false').check();
  await expect(group.getByLabel('Group 3 qualifies when')).toHaveValue('or');
  await group.getByRole('button', { name: 'Duplicate condition 3.1' }).click();
  await setSide(group.getByRole('group', { name: 'Condition 3.2', exact: true }), 'Right side', {
    type: 'Fixed value',
    value: '30',
  });
  await setSide(group.getByRole('group', { name: 'Condition 3.2', exact: true }), 'Left side', {
    type: 'Market data',
    instrument: 'DEMO-B',
  });

  // Remove the first top-level condition; numbering follows.
  await exit.getByRole('button', { name: 'Remove condition 1', exact: true }).click();
  await exit.getByLabel('Qualifies when', { exact: true }).selectOption('or');

  const expected = 'DEMO-A close > 10 OR NOT (DEMO-A close > 0 OR DEMO-B close > 30)';
  await expect(readsAs).toHaveText(`Reads as: ${expected}`);

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  await page.reload();
  await expect(readsAs).toHaveText(`Reads as: ${expected}`);
  await expect(
    exit
      .getByRole('region', { name: 'Group 2' })
      .getByLabel('NOT: qualify when this group is false'),
  ).toBeChecked();
});

test('shows field problems and blocks saving until they are fixed', async ({ page, baseURL }) => {
  await signUpAndVerify(page, uniqueEmail('invalid'));
  await newStrategy(page, baseURL!, 'Typos');
  const entry = page.getByRole('region', { name: 'Entry conditions' });
  await entry.getByRole('button', { name: 'Add condition to Entry conditions' }).click();
  const value = side(
    entry.getByRole('group', { name: 'Condition 1', exact: true }),
    'Right side',
  ).getByLabel('Value', { exact: true });
  await value.fill('1,000');
  await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(entry.getByText('Must be a decimal number')).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('main [role=alert]')).toContainText('Fix the highlighted fields');
  await value.fill('1000');
  await expect(value).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
});

test('detects edits made in another tab and warns before leaving unsaved work', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('conflict'));
  const id = await newStrategy(page, baseURL!, 'Two tabs');
  const other = await page.context().newPage();
  await other.goto(`/strategy-lab/${id}`);

  for (const p of [page, other]) {
    await p
      .getByRole('region', { name: 'Entry conditions' })
      .getByRole('button', { name: 'Add condition to Entry conditions' })
      .click();
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  await other.getByRole('button', { name: 'Save draft' }).click();
  await expect(other.locator('main [role=alert]')).toContainText('changed somewhere else');
  await expect(other.getByRole('button', { name: 'Reload the latest version' })).toBeVisible();

  const dialog = new Promise<string>((resolve) =>
    other.once('dialog', (d) => {
      resolve(d.type());
      void d.accept();
    }),
  );
  await other.close({ runBeforeUnload: true });
  expect(await dialog).toBe('beforeunload');
});
