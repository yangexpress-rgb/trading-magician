import { expect } from '@playwright/test';
import { createStrategyWithRules, group, leg, pickRunDates } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

const THIS = '00000000-0000-0000-0000-000000000000';
const ret12 = (id: string, instrumentId: string) => ({
  kind: 'metric',
  id,
  metric: 'return',
  params: { lookbackMonths: '12', skipMonths: '0' },
  instrumentId,
});

/**
 * Dual momentum with per-leg conditions only (v1.2 item 2): no shared Entry
 * condition. Each leg holds when its own 12-month return beats the others'
 * and is above 0.
 */
function dualMomentum(ids: Record<string, string>, accountId: string) {
  const legs = ['DEMO-A', 'DEMO-B', 'DEMO-C'].map((s) => [s, ids[s]!] as const);
  const empty = (id: string) => ({ kind: 'group', id, op: 'and', negate: false, children: [] });
  const trigger = { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 };
  return {
    entry: {
      // Check Entry (ADR 0073).
      schedule: { frequency: 'monthEnd' },
      condition: empty('eg'),
      trigger,
      orders: legs.map(([s, id], i) => ({
        ...leg(`buy-${i}`, `Buy ${s}`, id, accountId, 'buy'),
        legCondition: {
          ...group(`lg${i}`, {
            kind: 'comparison',
            id: `pos${i}`,
            operator: 'gt',
            left: ret12(`m${i}`, THIS),
            right: { kind: 'constant', id: `z${i}`, value: '0' },
          }),
          children: [
            {
              kind: 'comparison',
              id: `pos${i}`,
              operator: 'gt',
              left: ret12(`m${i}`, THIS),
              right: { kind: 'constant', id: `z${i}`, value: '0' },
            },
            ...legs
              .filter(([, other]) => other !== id)
              .map(([, other], j) => ({
                kind: 'comparison',
                id: `vs${i}${j}`,
                operator: 'gt',
                left: ret12(`a${i}${j}`, THIS),
                right: ret12(`b${i}${j}`, other),
              })),
          ],
        },
      })),
    },
    exit: {
      condition: empty('xg'),
      trigger,
      orders: legs.map(([s, id], i) => leg(`sell-${i}`, `Sell ${s}`, id, accountId, 'close')),
    },
  };
}

test('dual momentum with per-leg conditions and no shared Entry condition validates, starts and back tests', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('dual'));
  const strategy = await createStrategyWithRules(page, baseURL!, 'Dual momentum', dualMomentum);
  const headers = { origin: baseURL! };

  const validation = await (
    await page.request.post(`/api/v1/strategies/${strategy.id}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);

  await page.goto(`/strategy-lab/${strategy.id}`);
  // The editor shows no problem either: Entry's own conditions are empty, the legs carry theirs.
  const checks = page.getByRole('region', { name: 'Validation' });
  await expect(checks.getByRole('heading', { name: /problems? blocks? starting/ })).toHaveCount(0);
  await expect(page.getByText('Add at least one Entry condition')).toHaveCount(0);
  const panel = page.getByRole('region', { name: 'Run a back test', exact: true });
  await pickRunDates(panel, '2024-12-31', '2y', 'Dec 31, 2022 to Dec 31, 2024');
  await panel.getByRole('button', { name: 'Run back test' }).click();
  const results = page.getByRole('region', { name: 'Back test results' });
  await expect(results.getByText('Completed')).toBeVisible({ timeout: 60_000 });
  await results.getByText('Rules and full logs').click();
  await expect(results.getByRole('heading', { name: 'Leg rounds' })).toBeVisible();

  // Start is not refused for want of a shared Entry condition.
  const current = await (await page.request.get(`/api/v1/strategies/${strategy.id}`)).json();
  const codes = (validation.warnings as { code: string }[]).map((w) => w.code);
  const start = await page.request.post(`/api/v1/strategies/${strategy.id}/start`, {
    headers,
    data: {
      rowVersion: current.rowVersion,
      mode: 'paper',
      confirmed: true,
      acknowledgedWarnings: [...codes, 'backtest_stale', 'backtest_missing'],
    },
  });
  const body = await start.text();
  expect(body).not.toContain('empty_condition');
  expect(start.status(), body).toBeLessThan(300);
});
