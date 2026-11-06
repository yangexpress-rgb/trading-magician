import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Settings › Data feeds (§9.2–9.4, §15.4, ADR 0038): feeds are tested by the
 * worker, each price feed lists its routes underneath it, a new feed gets its
 * routes (or backs up existing ones) on its own and they go with it, and
 * turning off a feed that running strategies depend on asks first.
 */

const comparison = (id: string, instrumentId: string, operator: 'gt' | 'lt') => ({
  kind: 'comparison',
  id,
  operator,
  left: { kind: 'market', id: `${id}-px`, ...series(instrumentId) },
  right: { kind: 'constant', id: `${id}-k`, value: '1' },
});
const whileTrue = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };

/** Never enters (price below 1), so it runs without placing orders. */
const idle = (ids: Record<string, string>, account: string) => {
  const a = ids['DEMO-A']!;
  return {
    entry: {
      condition: group('eg', comparison('in', a, 'lt')),
      trigger: whileTrue,
      orders: [leg('buy', 'Buy DEMO-A', a, account, 'buy')],
    },
    exit: {
      condition: group('xg', comparison('out', a, 'lt')),
      trigger: whileTrue,
      orders: [leg('close', 'Close DEMO-A', a, account, 'close')],
    },
  };
};

test('tests feeds, sets a fallback and turns a feed off safely', async ({ page, baseURL }) => {
  await signUpAndVerify(page, uniqueEmail('feeds'));
  const headers = { origin: baseURL! };

  // A running strategy that gets its prices from the demo feed.
  const strategy = await createStrategyWithRules(page, baseURL!, 'Idle watcher', idle);
  const validation = await (
    await page.request.post(`/api/v1/strategies/${strategy.id}/validate`, { headers })
  ).json();
  const started = await page.request.post(`/api/v1/strategies/${strategy.id}/start`, {
    headers,
    data: {
      rowVersion: strategy.rowVersion,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [...new Set(validation.warnings.map((w: { code: string }) => w.code))],
    },
  });
  expect(started.status()).toBe(200);

  await page.goto('/settings/data-feeds');
  const feeds = page.getByRole('list', { name: 'Price feeds' });
  const demo = feeds.getByRole('listitem', { name: 'Demo feed', exact: true });
  const demoRoutes = demo.getByRole('table', { name: 'Routes for Demo feed' });
  await expect(demoRoutes).toContainText('Stocks live prices');
  await expect(demoRoutes).toContainText('Demo instruments');

  // Test asks the worker to check it now; the result comes back live.
  await demo.getByRole('button', { name: 'Test Demo feed' }).click();
  await expect(demo).not.toContainText('last checked never');
  await expect(demo.getByRole('button', { name: 'Test Demo feed' })).toBeEnabled();
  await expect(demo.getByText('Healthy')).toBeVisible();

  // A second feed is tested as soon as it is added.
  await page.getByRole('button', { name: 'Add a feed' }).click();
  const add = page.getByRole('dialog', { name: 'Add a data feed' });
  await add.getByLabel('Provider').selectOption({ label: 'Demo (built in)' });
  await add.getByLabel('Name').fill('Backup demo feed');
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();
  const backup = feeds.getByRole('listitem', { name: 'Backup demo feed' });
  await expect(backup.getByText('Healthy')).toBeVisible();
  // It backs up the demo feed's routes on its own.
  await expect(backup).toContainText(
    'Backup for Stocks live prices (demo instruments) from Demo feed',
  );
  await expect(
    demoRoutes.getByLabel('Backup feed for Stocks live prices, demo instruments'),
  ).toHaveValue(/.+/);

  // Removing it while it is a backup is allowed and takes it off those routes.
  await backup.getByRole('button', { name: 'Remove' }).click();
  await page
    .getByRole('dialog', { name: 'Remove Backup demo feed?' })
    .getByRole('button', { name: 'Remove feed' })
    .click();
  await expect(backup).toBeHidden();
  await expect(
    demoRoutes.getByLabel('Backup feed for Stocks live prices, demo instruments'),
  ).toHaveValue('');

  // Added again, it backs them up again.
  await page.getByRole('button', { name: 'Add a feed' }).click();
  await add.getByLabel('Provider').selectOption({ label: 'Demo (built in)' });
  await add.getByLabel('Name').fill('Backup demo feed');
  await add.getByRole('button', { name: 'Add feed' }).click();
  await expect(add).toBeHidden();
  await expect(backup).toContainText(
    'Backup for Stocks live prices (demo instruments) from Demo feed',
  );

  // Removing the demo feed is refused while a running strategy gets prices from it.
  await demo.getByRole('button', { name: 'Remove' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove Demo feed?' });
  await expect(remove).toContainText('deleted with it');
  await remove.getByRole('button', { name: 'Remove feed' }).click();
  await expect(page.getByText('Idle watcher gets prices from this feed.')).toBeVisible();
  await expect(remove).toBeHidden();

  // Turning off the demo feed names the strategy and offers a replacement or a pause.
  await demo.getByRole('button', { name: 'Turn off' }).click();
  const turnOff = page.getByRole('dialog', { name: 'Turn off Demo feed?' });
  await expect(turnOff).toContainText('Idle watcher gets prices from it.');
  await expect(turnOff.getByLabel('Pause Idle watcher')).toBeVisible();
  await expect(turnOff.getByLabel('Move its routes to another feed')).toBeChecked();
  await expect(turnOff.getByLabel('Replacement feed')).toHaveValue(/.+/);

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);

  // Moving its routes keeps the strategy running on the backup feed.
  await turnOff.getByRole('button', { name: 'Turn off' }).click();
  await expect(turnOff).toBeHidden();
  await expect(demo.getByText('Off', { exact: true })).toBeVisible();
  await expect(demo).toContainText('No routes while off.');
  await expect(backup.getByRole('table', { name: 'Routes for Backup demo feed' })).toContainText(
    'Stocks live prices',
  );
  const execution = await (await page.request.get('/api/v1/execution')).json();
  expect(
    execution.runtimes.find((r: { strategyId: string }) => r.strategyId === strategy.id)?.status,
  ).toBe('running');
});
