import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Settings › Trading platforms (§9.3, §9.4, ADR 0018). The worker talks to a
 * fake Alpaca (ALPACA_FAKE in playwright.config.ts) with a made-up paper key.
 */

const FAKE_KEY_ID = 'PKFAKEKEYID000000001';
const FAKE_SECRET = 'fake-secret-key-for-tests-only-0001';

const comparison = (id: string, instrumentId: string) => ({
  kind: 'comparison',
  id,
  operator: 'lt',
  left: { kind: 'market', id: `${id}-px`, ...series(instrumentId) },
  right: { kind: 'constant', id: `${id}-k`, value: '1' },
});
const whileTrue = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };

/** Never enters (price below 1), so it runs without placing orders. */
const idle =
  () =>
  (ids: Record<string, string>, account: string) => {
    const a = ids['DEMO-A']!;
    return {
      entry: {
        condition: group('eg', comparison('in', a)),
        trigger: whileTrue,
        orders: [leg('buy', 'Buy DEMO-A', a, account, 'buy')],
      },
      exit: {
        condition: group('xg', comparison('out', a)),
        trigger: whileTrue,
        orders: [leg('close', 'Close DEMO-A', a, account, 'close')],
      },
    };
  };

test('connects a second paper account, makes it the default and turns one off safely', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('platforms'));
  const headers = { origin: baseURL! };

  // A running strategy on the demo account.
  const watcher = await createStrategyWithRules(page, baseURL!, 'Idle watcher', idle());
  const validation = await (
    await page.request.post(`/api/v1/strategies/${watcher.id}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);
  const started = await page.request.post(`/api/v1/strategies/${watcher.id}/start`, {
    headers,
    data: {
      rowVersion: watcher.rowVersion,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [...new Set(validation.warnings.map((w: { code: string }) => w.code))],
    },
  });
  expect(started.status()).toBe(200);

  // The demo account cannot place extended-hours orders, and validation says so:
  // extended hours is the strategy's market-hours setting (ADR 0049).
  const late = await createStrategyWithRules(page, baseURL!, 'After hours', idle());
  const lateDraft = await (await page.request.get(`/api/v1/strategies/${late.id}`)).json();
  const extended = await page.request.patch(`/api/v1/strategies/${late.id}`, {
    headers,
    data: {
      rowVersion: lateDraft.rowVersion,
      definition: {
        ...lateDraft.definition,
        execution: { ...lateDraft.definition.execution, marketHoursPolicy: 'extended_if_supported' },
      },
    },
  });
  expect(extended.status()).toBe(200);
  const lateCheck = await (
    await page.request.post(`/api/v1/strategies/${late.id}/validate`, { headers })
  ).json();
  expect(lateCheck.warnings.map((e: { message: string }) => e.message)).toContain(
    '"Buy DEMO-A" waits for the regular session: "Demo paper account" doesn\'t trade extended hours',
  );

  await page.goto('/settings/accounts');
  const platforms = page.getByRole('list', { name: 'Trading platforms' });
  const demo = platforms.getByRole('listitem', { name: 'Demo paper broker' });
  await expect(demo.getByRole('table', { name: 'Demo paper broker accounts' })).toContainText(
    'Used by Idle watcher',
  );

  // Adding Alpaca with a paper key connects it and finds its account.
  await page.getByRole('button', { name: 'Add a platform' }).click();
  const add = page.getByRole('dialog', { name: 'Add a trading platform' });
  await add.getByLabel('Platform').selectOption({ label: 'Alpaca' });
  await add.getByLabel('Name', { exact: true }).fill('Alpaca');
  await add.getByLabel('API key ID').fill(FAKE_KEY_ID);
  await add.getByLabel('Secret key').fill(FAKE_SECRET);
  await add.getByRole('button', { name: 'Add platform' }).click();
  await expect(add).toBeHidden();
  const alpaca = platforms.getByRole('listitem', { name: 'Alpaca', exact: true });
  await expect(alpaca.getByText('Healthy')).toBeVisible();
  await expect(alpaca.getByText('Paper', { exact: true })).toBeVisible();
  const accounts = alpaca.getByRole('table', { name: 'Alpaca accounts' });
  await expect(accounts).toContainText('Alpaca paper ••••0042');
  await expect(accounts).toContainText('US listings');
  expect(await page.content()).not.toContain(FAKE_SECRET);

  // Even before it is the default, new strategies start on the Alpaca paper account.
  const before = await (
    await page.request.post('/api/v1/strategies', { data: { name: 'Before default' }, headers })
  ).json();
  const brokers = await (await page.request.get('/api/v1/brokers')).json();
  const alpacaPaper = brokers.platforms
    .flatMap((p: { accounts: { id: string; nickname: string }[] }) => p.accounts)
    .find((a: { nickname: string }) => a.nickname === 'Alpaca paper ••••0042');
  expect(before.defaultAccountId).toBe(alpacaPaper.id);

  // Make it the default: new strategies use it.
  await accounts.getByRole('button', { name: 'Make Alpaca paper ••••0042 the default' }).click();
  const makeDefault = page.getByRole('dialog', { name: 'Make Alpaca paper ••••0042 the default?' });
  await makeDefault.getByRole('button', { name: 'Make default' }).click();
  await expect(makeDefault).toBeHidden();
  await expect(accounts.getByText('Default')).toBeVisible();
  const list = await (await page.request.get('/api/v1/brokers')).json();
  const alpacaAccount = list.platforms
    .flatMap((p: { accounts: { id: string; nickname: string }[] }) => p.accounts)
    .find((a: { nickname: string }) => a.nickname === 'Alpaca paper ••••0042');
  const fresh = await (
    await page.request.post('/api/v1/strategies', { data: { name: 'Fresh' }, headers })
  ).json();
  expect(fresh.defaultAccountId).toBe(alpacaAccount.id);

  // Turning off routing to the demo account names the strategy and pauses it on consent.
  await demo.getByRole('button', { name: 'Turn off routing to Demo paper account' }).click();
  const turnOff = page.getByRole('dialog', { name: 'Turn off Demo paper account?' });
  await expect(turnOff).toContainText('Idle watcher trades through it and will be paused.');

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);

  await turnOff.getByRole('button', { name: 'Pause and turn off' }).click();
  await expect(turnOff).toBeHidden();
  await expect(
    demo.getByRole('button', { name: 'Turn on routing to Demo paper account' }),
  ).toBeVisible();
  const execution = await (await page.request.get('/api/v1/execution')).json();
  expect(
    execution.runtimes.find((r: { strategyId: string }) => r.strategyId === watcher.id)?.status,
  ).toBe('paused');
});
