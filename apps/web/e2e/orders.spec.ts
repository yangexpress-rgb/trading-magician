import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

async function newStrategy(page: Page, baseURL: string, name: string): Promise<string> {
  const res = await page.request.post('/api/v1/strategies', {
    data: { name },
    headers: { origin: baseURL },
  });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/strategy-lab/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return id;
}

async function selectByText(select: Locator, text: string) {
  const label = await select.locator('option', { hasText: text }).first().textContent();
  await select.selectOption({ label: label! });
}

interface Leg {
  name: string;
  symbol: string;
  side: string;
  quantity: string;
}

async function addLeg(page: Page, phase: 'Entry' | 'Exit', n: number, leg: Leg) {
  await page.getByRole('button', { name: `+ Add ${phase} order` }).click();
  const row = page.getByRole('region', { name: `${phase} leg ${n}`, exact: true });
  await row.getByLabel('Leg name').fill(leg.name);
  await selectByText(row.getByLabel('Instrument', { exact: true }), `${leg.symbol} ·`);
  await row.getByLabel('Side').selectOption({ label: leg.side });
  await row.getByLabel('Quantity', { exact: true }).fill(leg.quantity);
  return row;
}

async function fiveMinutesAfterEntrySubmitted(row: Locator) {
  await row.getByRole('radio', { name: 'After a delay' }).check();
  await row.getByLabel('Wait', { exact: true }).fill('5');
  await row.getByLabel('Unit').selectOption({ label: 'minutes' });
  await row.getByLabel('After', { exact: true }).selectOption({ label: 'Entry order submitted' });
}

async function api(page: Page, baseURL: string, id: string) {
  const strategy = await (await page.request.get(`/api/v1/strategies/${id}`)).json();
  const validation = await (
    await page.request.post(`/api/v1/strategies/${id}/validate`, { headers: { origin: baseURL } })
  ).json();
  return { definition: strategy.definition, validation };
}

test('long DEMO-A and short DEMO-B on Entry; Exit legs 5 minutes after the Entry order is submitted', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('legs'));
  const id = await newStrategy(page, baseURL!, 'Pairs with timed exit');

  await addLeg(page, 'Entry', 1, {
    name: 'Long A',
    symbol: 'DEMO-A',
    side: 'Buy',
    quantity: '100',
  });
  await addLeg(page, 'Entry', 2, {
    name: 'Short B',
    symbol: 'DEMO-B',
    side: 'Sell short',
    quantity: '100',
  });
  await expect(page.getByText('These legs are sent as separate orders').first()).toBeVisible();

  // Exit is pre-filled with the opposite of each Entry leg ("Mirror Entry legs" is on);
  // turning the mirror off makes the Exit legs editable.
  const exitRow = (n: number) => page.getByRole('region', { name: `Exit leg ${n}`, exact: true });
  await expect(page.getByLabel('Mirror Entry legs')).toBeChecked();
  const sellA = exitRow(1);
  await expect(sellA.getByLabel('Side')).toHaveValue('sell');
  await expect(sellA.getByLabel('Quantity', { exact: true })).toHaveValue('100');
  await page.getByLabel('Mirror Entry legs').uncheck();
  await sellA.getByLabel('Leg name').fill('Sell A');
  await fiveMinutesAfterEntrySubmitted(sellA);
  const coverB = exitRow(2);
  await expect(coverB.getByLabel('Side')).toHaveValue('buy_to_cover');
  await coverB.getByLabel('Leg name').fill('Cover B');
  await fiveMinutesAfterEntrySubmitted(coverB);
  await expect(sellA.getByText('Timing: 5 minutes after entry order submitted')).toBeVisible();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  const before = await api(page, baseURL!, id);
  const { entry, exit } = before.definition;
  expect(entry.orders.map((o: { legLabel: string; side: string }) => [o.legLabel, o.side])).toEqual(
    [
      ['Long A', 'buy'],
      ['Short B', 'sell_short'],
    ],
  );
  expect(entry.orders[0].instrumentId).not.toBe(entry.orders[1].instrumentId);
  for (const leg of exit.orders) {
    expect(leg.timing).toEqual({
      mode: 'relative',
      amount: 5,
      unit: 'min',
      reference: { kind: 'phase', event: 'entry_submitted' },
    });
  }
  // The legs pass every order, exposure and timing check; only the empty
  // conditions remain, and the non-atomic multi-leg warning is raised.
  expect([...new Set(before.validation.errors.map((e: { code: string }) => e.code))]).toEqual([
    'empty_condition',
  ]);
  expect(before.validation.warnings.map((w: { code: string }) => w.code)).toContain(
    'non_atomic_multi_leg',
  );

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'Exit leg 2', exact: true });
  await expect(reloaded.getByLabel('Leg name')).toHaveValue('Cover B');
  await expect(reloaded.getByRole('radio', { name: 'After a delay' })).toBeChecked();
  await expect(reloaded.getByText('Timing: 5 minutes after entry order submitted')).toBeVisible();
  expect((await api(page, baseURL!, id)).definition).toEqual(before.definition);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
});

test('exact zoned times, limit prices, sequential legs and risk limits round-trip', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('exact'));
  const id = await newStrategy(page, baseURL!, 'Scheduled');

  const leg = await addLeg(page, 'Entry', 1, {
    name: 'Open A',
    symbol: 'DEMO-A',
    side: 'Buy',
    quantity: '10',
  });
  await leg.getByLabel('Order type').selectOption({ label: 'Limit' });
  const limit = leg.getByRole('group', { name: 'Limit price', exact: true });
  await limit.getByLabel('Type', { exact: true }).selectOption({ label: 'Fixed value' });
  await limit.getByLabel('Value', { exact: true }).fill('99.5');

  await leg.getByRole('radio', { name: 'At an exact date and time' }).check();
  await expect(leg.getByLabel('Time zone')).toHaveValue('America/New_York');
  await leg.getByLabel('Date and time', { exact: true }).fill('2027-01-15T09:30');
  await addLeg(page, 'Entry', 2, { name: 'Open B', symbol: 'DEMO-B', side: 'Buy', quantity: '10' });

  await page.getByLabel('Send legs').selectOption({ label: 'One after another, in order' });
  await page.getByRole('button', { name: 'Send Open B earlier' }).click();
  await page.getByLabel(/^Daily loss limit/).fill('');

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');

  const { definition, validation } = await api(page, baseURL!, id);
  const [a, b] = definition.entry.orders;
  expect(a.timing).toEqual({
    mode: 'exact',
    at: '2027-01-15T09:30:00-05:00',
    zone: 'America/New_York',
  });
  expect(a).toMatchObject({ orderType: 'limit', limitPrice: { kind: 'constant', value: '99.5' } });
  expect(definition.execution).toMatchObject({
    multiLegPolicy: 'sequential',
    // Exit legs were pre-filled from Entry, so they are in the submission order too.
    legOrder: [b.id, a.id, ...definition.exit.orders.map((o: { id: string }) => o.id)],
  });
  expect(definition.exit.orders).toHaveLength(2);
  expect(definition.risk.dailyLossLimit).toBeUndefined();
  expect(validation.errors.map((e: { code: string }) => e.code)).toContain('missing_risk_limit');

  await page.reload();
  const again = page.getByRole('region', { name: 'Entry leg 1', exact: true });
  await expect(again.getByLabel('Date and time', { exact: true })).toHaveValue('2027-01-15T09:30');
  await expect(page.getByLabel(/^Daily loss limit/)).toHaveValue('');
  await expect(page.getByRole('list').filter({ hasText: '1.Open B' })).toBeVisible();
});

test('Exit orders mirror Entry while "Mirror Entry legs" is on, and are hand-built when off', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('mirror'));
  await newStrategy(page, baseURL!, 'Mirrored exit');

  await addLeg(page, 'Entry', 1, { name: 'Long A', symbol: 'DEMO-A', side: 'Buy', quantity: '50' });
  const entry = page.getByRole('region', { name: 'Entry leg 1', exact: true });
  const exit = page.getByRole('region', { name: 'Exit leg 1', exact: true });
  await expect(exit.getByLabel('Leg name')).toHaveValue('Exit Long A');
  await expect(exit.getByLabel('Side')).toHaveValue('sell');
  await expect(exit.getByLabel('Quantity', { exact: true })).toHaveValue('50');
  await expect(exit.getByLabel('Instrument', { exact: true })).toHaveValue(
    await entry.getByLabel('Instrument', { exact: true }).inputValue(),
  );

  // With the mirror on, Entry changes regenerate Exit, and Exit legs are not edited by hand.
  const mirror = page.getByLabel('Mirror Entry legs');
  await expect(mirror).toBeChecked();
  await entry.getByLabel('Side').selectOption({ label: 'Sell short' });
  await entry.getByLabel('Quantity', { exact: true }).fill('70');
  await expect(exit.getByLabel('Side')).toHaveValue('buy_to_cover');
  await expect(exit.getByLabel('Quantity', { exact: true })).toHaveValue('70');
  await expect(exit.getByLabel('Quantity', { exact: true })).toBeDisabled();

  // Off: Exit is the user's own, and Entry edits leave it alone.
  await mirror.uncheck();
  await exit.getByLabel('Quantity', { exact: true }).fill('30');
  await entry.getByLabel('Quantity', { exact: true }).fill('80');
  await expect(exit.getByLabel('Quantity', { exact: true })).toHaveValue('30');

  // On again: Exit is the opposite of Entry once more.
  await mirror.check();
  await expect(exit.getByLabel('Quantity', { exact: true })).toHaveValue('80');
});
