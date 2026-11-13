import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { createStrategyWithRules, group, leg, series } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Settings as a whole (§9.1, §15.4, §16.3, §19.7): the five sections in
 * order, profile formats, notification preferences, and accessibility on
 * every section once its content has loaded.
 */

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(
    results.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

const never = (id: string, instrumentId: string) => ({
  kind: 'comparison',
  id,
  operator: 'lt',
  left: { kind: 'market', id: `${id}-px`, ...series(instrumentId) },
  right: { kind: 'constant', id: `${id}-k`, value: '1' },
});
const whileTrue = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
const idle = (ids: Record<string, string>, account: string) => {
  const a = ids['DEMO-A']!;
  return {
    entry: {
      condition: group('eg', never('in', a)),
      trigger: whileTrue,
      orders: [leg('buy', 'Buy DEMO-A', a, account, 'buy')],
    },
    exit: {
      condition: group('xg', never('out', a)),
      trigger: whileTrue,
      orders: [leg('close', 'Close DEMO-A', a, account, 'close')],
    },
  };
};

test('settings sections, profile formats and notification preferences', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('settings'));
  const headers = { origin: baseURL! };

  // The five sections of §15.4 plus AI agents (N262), in order.
  await page.goto('/settings/profile');
  await expect(
    page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link'),
  ).toHaveText([
    'Profile',
    'Data feeds',
    'Trading platforms and accounts',
    'Subscription and billing',
    'AI agents',
    'Notifications and security',
  ]);

  // Profile: the date and number format shows an example before saving, and is kept.
  const profile = page.getByRole('form', { name: 'Profile' });
  const format = profile.getByLabel('Date and number format');
  await expect(profile).toContainText('$12,345.67');
  await format.selectOption({ label: 'Deutsch (Deutschland)' });
  await expect(profile).toContainText('12.345,67');
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(profile.getByText('Profile saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Date and number format')).toHaveValue('de-DE');
  await expect(page.getByRole('link', { name: 'Subscription and billing' }).last()).toBeVisible();
  await expectAccessible(page);

  // Notifications: mute strategy starts; the kinds that stop trading cannot be muted.
  await page.goto('/settings/security');
  await expect(page.getByLabel('A strategy is paused for safety (always shown)')).toBeDisabled();
  await expect(page.getByLabel('A strategy is paused for safety (always shown)')).toBeChecked();
  await expect(
    page.getByLabel('A data feed or trading platform stops responding (always shown)'),
  ).toBeDisabled();
  await page.getByLabel('A strategy starts').uncheck();
  await page.getByRole('button', { name: 'Save notification preferences' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await expectAccessible(page);
  await page.reload();
  await expect(page.getByLabel('A strategy starts')).not.toBeChecked();
  await expect(page.getByLabel('A strategy stops')).toBeChecked();

  // A start is no longer announced; a stop still is.
  const s = await createStrategyWithRules(page, baseURL!, 'Quiet starter', idle);
  const validation = await (
    await page.request.post(`/api/v1/strategies/${s.id}/validate`, { headers })
  ).json();
  const started = await page.request.post(`/api/v1/strategies/${s.id}/start`, {
    headers,
    data: {
      rowVersion: s.rowVersion,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [...new Set(validation.warnings.map((w: { code: string }) => w.code))],
    },
  });
  expect(started.status()).toBe(200);
  const stopped = await page.request.post(`/api/v1/strategies/${s.id}/stop`, {
    headers,
    data: { rowVersion: (await started.json()).rowVersion },
  });
  expect(stopped.status()).toBe(200);
  await page.goto('/notifications');
  const notices = page.getByRole('list', { name: 'Notifications' });
  await expect(
    notices.getByRole('listitem', { name: 'Quiet starter stopped, unread' }),
  ).toBeVisible();
  await expect(notices.getByRole('listitem', { name: /Quiet starter started/ })).toHaveCount(0);

  // Every other section passes the accessibility checks once loaded.
  await page.goto('/settings/data-feeds');
  await expect(
    page
      .getByRole('list', { name: 'Price feeds' })
      .getByRole('listitem', { name: 'Demo feed', exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.goto('/settings/accounts');
  await expect(page.getByRole('table', { name: 'Demo paper broker accounts' })).toBeVisible();
  await expectAccessible(page);
  await page.goto('/settings/billing');
  await expect(
    page.getByRole('heading', { name: 'Subscription and billing', level: 2 }),
  ).toBeVisible();
  await expectAccessible(page);
});
