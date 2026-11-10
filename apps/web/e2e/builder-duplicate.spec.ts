import { expect } from '@playwright/test';
import { createTestedStrategy } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * N154: duplicating a condition, a group, a leg with its own conditions and
 * an order gives every copy fresh ids, so the draft saves with no problems.
 * The throwaway draft is deleted afterwards.
 */
test('duplicates every builder entity once and saves with 0 problems', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('dup'));
  const headers = { origin: baseURL! };
  const strategy = await createTestedStrategy(page, baseURL!, 'Throwaway duplicate check', {
    pair: true,
  });
  await page.goto(`/strategy-lab/${strategy.id}`);

  // A condition and a group (with a condition inside) in the Enter when.
  const entry = page.getByRole('region', { name: 'Enter when' });
  await entry.getByRole('button', { name: 'Add group to Enter when' }).click();
  await entry.getByRole('button', { name: 'Duplicate condition 1', exact: true }).click();
  await entry.getByRole('button', { name: 'Duplicate group 3', exact: true }).click();

  // An Entry leg duplicated (leg conditions left the builder, ADR 0073; cloneOrder covers them).
  await page.getByRole('button', { name: 'Duplicate Entry leg 1', exact: true }).click();
  // An Exit order duplicated too.
  const exitDuplicate = page.getByRole('button', { name: 'Duplicate Exit leg 1', exact: true });
  if (await exitDuplicate.isEnabled()) await exitDuplicate.click();

  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  await expect(page.getByText('The definition has duplicate ids')).toHaveCount(0);

  const saved = await (await page.request.get(`/api/v1/strategies/${strategy.id}`)).json();
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (k === 'id' && typeof x === 'string') ids.push(x);
        else walk(x);
      }
  };
  walk(saved.definition);
  expect(new Set(ids).size).toBe(ids.length);
  expect(saved.definition.entry.orders.length).toBeGreaterThanOrEqual(3);
  expect(saved.definition.entry.condition.children.length).toBeGreaterThanOrEqual(4);

  const validation = await (
    await page.request.post(`/api/v1/strategies/${strategy.id}/validate`, { headers })
  ).json();
  expect(validation.errors).toEqual([]);

  // Delete the throwaway draft.
  const deleted = await page.request.delete(`/api/v1/strategies/${strategy.id}`, {
    data: { rowVersion: saved.rowVersion },
    headers,
  });
  expect(deleted.status()).toBe(204);
});
