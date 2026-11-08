import { expect } from '@playwright/test';
import { createStrategyWithRules, leg } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/** One leg on DEMO-A, monthly: enough for a record of its own (ADR 0054). */
function oneLeg(ids: Record<string, string>, accountId: string) {
  return {
    entry: {
      condition: { kind: 'group', id: 'eg', op: 'and', negate: false, children: [] },
      trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
      orders: [leg('buy-a', 'Buy A', ids['DEMO-A']!, accountId, 'buy')],
    },
  };
}

test('Strategy Lab shows each strategy’s Library number and links entries from the builder', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('numbering'));
  const headers = { origin: baseURL! };

  // A draft with no Entry legs has no number yet.
  const draft = await (
    await page.request.post('/api/v1/strategies', { data: { name: 'Empty draft' }, headers })
  ).json();
  expect(draft.library).toBeNull();
  await page.goto(`/strategy-lab/${draft.id}`);
  await expect(page.getByText('Number assigned on first save with instruments.')).toBeVisible();

  // Saved with an instrument and no link, it gets a record of its own.
  const saved = await createStrategyWithRules(page, baseURL!, 'Numbered one', oneLeg);
  const detail = await (await page.request.get(`/api/v1/strategies/${saved.id}`)).json();
  const own = detail.library.registrationNumber as string;
  expect(own).toMatch(/^S\d{5}-SD$/);
  expect(detail.library.autoCreated).toBe(true);

  await page.goto('/strategy-lab');
  const row = page.getByRole('row', { name: /Numbered one/ });
  await expect(row.getByRole('link', { name: own })).toBeVisible();

  // The builder links an existing entry: the strategy takes its number.
  await page.goto(`/strategy-lab/${saved.id}`);
  const card = page.getByRole('region', { name: 'Library entry' });
  await expect(card.getByRole('link', { name: own })).toBeVisible();
  await card.getByRole('button', { name: 'Change entry' }).click();
  await card.getByLabel('Search the Library by number or name').fill('SMS-0009');
  // A former number finds the entry under its current number (ADR 0055).
  await card.getByRole('button', { name: /S00009-SM/ }).click();
  await expect(card.getByText(`uses S00009-SM`)).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText('All changes saved')).toBeVisible();
  await expect(card.getByRole('link', { name: 'S00009-SM' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Strategy Library entry S00009-SM' })).toBeVisible();

  // The Library shows the entry Built, and the old record Not built with its number.
  await page.goto('/library/S00009-SM');
  await expect(page.getByRole('link', { name: 'Numbered one' })).toBeVisible();
  const old = await (await page.request.get(`/api/v1/library/${own}`)).json();
  expect(old.builtStatus).toBe('not_built');
});
