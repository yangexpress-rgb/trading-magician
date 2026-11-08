import { expect, type Page } from '@playwright/test';
import { createStrategyWithRules, leg } from './backtest-fixtures';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Strategy sharing (ADR 0056) between two members: a Library record shared,
 * previewed and accepted into a new numbered record, and a Strategy Lab
 * strategy shared and accepted into the recipient's Lab with its own number.
 */

/** One leg on DEMO-A: enough for a Library number (ADR 0054). */
function oneLeg(ids: Record<string, string>, accountId: string) {
  return {
    entry: {
      condition: { kind: 'group', id: 'eg', op: 'and', negate: false, children: [] },
      trigger: { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 },
      orders: [leg('buy-a', 'Buy A', ids['DEMO-A']!, accountId, 'buy')],
    },
  };
}

async function memberId(page: Page): Promise<string> {
  await page.goto('/settings/profile');
  const text = (await page.getByText(/Your member ID is/).textContent()) ?? '';
  const code = /U\d{4,}/.exec(text)?.[0];
  expect(code).toBeTruthy();
  return code!;
}

async function shareWith(page: Page, code: string, note?: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Member ID or email').fill(code.toLowerCase());
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.getByRole('list', { name: 'Sharing with' })).toContainText(code);
  if (note) await dialog.getByLabel('Note (optional)').fill(note);
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText('Shared with 1 person.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
}

test('shares a Library record and a Lab strategy, and the recipient accepts copies', async ({
  page,
  newPage,
  baseURL,
}) => {
  const ben = await newPage();
  await signUpAndVerify(ben, uniqueEmail('share-ben'), 'Ben Recipient');
  const benCode = await memberId(ben);
  await signUpAndVerify(page, uniqueEmail('share-ann'), 'Ann Sender');
  const annCode = await memberId(page);

  // A Library record: the dialog finds Ben by member ID and sends it with a note.
  await page.goto('/library/S00003-SD');
  await page.getByRole('button', { name: /^Share S00003-SD/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Member ID or email').fill(annCode);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.getByText(/can’t receive shares/)).toBeVisible();
  await shareWith(page, benCode, 'Have a look at this one');

  // Ben sees it waiting, previews it, and accepts.
  await ben.goto('/sharing');
  await expect(ben.getByRole('link', { name: /^Sharing/ })).toContainText('1');
  const row = ben.getByRole('row', { name: /S00003-SD/ });
  await expect(row).toContainText(`Ann Sender (${annCode})`);
  await expect(row).toContainText('Waiting for an answer');
  await row.getByRole('link').first().click();
  await expect(ben.getByText('Have a look at this one')).toBeVisible();
  await expect(ben.getByRole('heading', { name: 'What was shared' })).toBeVisible();
  await ben.screenshot({ path: 'test-results/sharing-preview.png', fullPage: true });
  await ben.getByRole('button', { name: 'Accept and make my copy' }).click();
  await expect(ben).toHaveURL(/\/library\/S\d{5}-SD$/);
  const copy = /S\d{5}-SD$/.exec(ben.url())![0];
  expect(copy).not.toBe('S00003-SD');
  await expect(ben.getByText(`Ann Sender (${annCode})`)).toBeVisible();
  await expect(ben.getByText('#shared')).toBeVisible();
  await ben.screenshot({ path: 'test-results/sharing-library-copy.png', fullPage: true });

  // Ann is told, and sees the copy's number in what she shared.
  await page.goto('/notifications');
  await expect(
    page.getByText(`Ben Recipient (${benCode}) accepted S00003-SD; their copy is ${copy}`),
  ).toBeVisible();
  await page.goto('/sharing?box=sent');
  await expect(page.getByRole('row', { name: /S00003-SD/ })).toContainText('Accepted');

  // A Lab strategy: shared from the Strategy Lab list.
  const saved = await createStrategyWithRules(page, baseURL!, 'Ann’s shared strategy', oneLeg);
  const source = (await (await page.request.get(`/api/v1/strategies/${saved.id}`)).json()).library
    .registrationNumber as string;
  await page.goto('/strategy-lab');
  await page.getByRole('button', { name: new RegExp(`^Share ${source}`) }).click();
  await shareWith(page, benCode);

  await ben.goto('/sharing');
  await ben
    .getByRole('row', { name: new RegExp(source) })
    .getByRole('link')
    .first()
    .click();
  await expect(ben.getByText('Instruments: DEMO-A')).toBeVisible();
  await ben.getByRole('button', { name: 'Accept and make my copy' }).click();
  await expect(ben).toHaveURL(/\/strategy-lab\/[0-9a-f-]{36}$/);
  await expect(ben.getByRole('heading', { name: 'Ann’s shared strategy' })).toBeVisible();
  await expect(ben.getByText(`Ann Sender (${annCode})`)).toBeVisible();
  const own = ben.getByRole('link', { name: /^Strategy Library entry S\d{5}-SD$/ });
  await expect(own).toBeVisible();
  await expect(own).not.toHaveText(source);
  await ben.screenshot({ path: 'test-results/sharing-lab-copy.png', fullPage: true });

  await ben.goto('/strategy-lab?shared=1');
  await expect(ben.getByRole('row', { name: /Ann’s shared strategy/ })).toContainText('Shared');
});

test('declines and withdraws', async ({ page, newPage }) => {
  const ben = await newPage();
  await signUpAndVerify(ben, uniqueEmail('share-decline'), 'Dee Clines');
  const code = await memberId(ben);
  await signUpAndVerify(page, uniqueEmail('share-withdraw'), 'Will Draws');

  await page.goto('/library/S00004-SD');
  await page.getByRole('button', { name: /^Share S00004-SD/ }).click();
  await shareWith(page, code);
  await page.goto('/library/S00005-SD');
  await page.getByRole('button', { name: /^Share S00005-SD/ }).click();
  await shareWith(page, code);

  await ben.goto('/sharing');
  await ben
    .getByRole('row', { name: /S00004-SD/ })
    .getByRole('link')
    .first()
    .click();
  await ben.getByRole('button', { name: 'Decline' }).click();
  await expect(ben.getByText('This share is closed: declined.')).toBeVisible();

  await page.goto('/sharing?box=sent');
  await page
    .getByRole('row', { name: /S00005-SD/ })
    .getByRole('link')
    .first()
    .click();
  await page.getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('This share is closed: withdrawn.')).toBeVisible();
  await page.goto('/sharing?box=sent');
  await expect(page.getByRole('row', { name: /S00004-SD/ })).toContainText('Declined');
});

test('shares several Library records in one send', async ({ page, newPage }) => {
  const ben = await newPage();
  await signUpAndVerify(ben, uniqueEmail('share-many'), 'Manny Recipient');
  const code = await memberId(ben);
  await signUpAndVerify(page, uniqueEmail('share-many-sender'), 'Multi Sender');

  await page.goto('/library');
  await expect(page.getByRole('button', { name: 'Share selected', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /^Select S00006-SD/ }).check();
  await page.getByRole('checkbox', { name: /^Select S00007-SY/ }).check();
  await page.getByRole('button', { name: 'Share selected (2)' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Share 2 records' })).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Sharing these' })).toContainText('S00007-SY');
  await dialog.getByLabel('Member ID or email').fill(code);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.getByRole('list', { name: 'Sharing with' })).toContainText(code);
  await page.screenshot({ path: 'test-results/sharing-many.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(dialog.getByText(/Made 2 shares/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Share selected', exact: true })).toBeDisabled();

  await ben.goto('/sharing');
  await expect(ben.getByRole('row', { name: /S00006-SD/ })).toContainText('Waiting for an answer');
  await expect(ben.getByRole('row', { name: /S00007-SY/ })).toContainText('Waiting for an answer');
});
