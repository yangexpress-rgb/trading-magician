import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { createDb, setPlatformAdmin } from '@tm/db';
import { PASSWORD, signIn, signUpAndVerify, test, uniqueEmail } from './fixtures';

/** The admin page (ADR 0037). */

const sections = (page: Page) => page.getByRole('navigation', { name: 'Admin sections' });

async function makeAdmin(email: string): Promise<void> {
  const ownerUrl = process.env.DATABASE_URL;
  const authUrl = process.env.DATABASE_AUTH_URL;
  if (!ownerUrl || !authUrl) throw new Error('DATABASE_URL and DATABASE_AUTH_URL are required');
  const owner = createDb(ownerUrl, { max: 1 });
  const auth = createDb(authUrl, { max: 1 });
  try {
    expect(await setPlatformAdmin(owner.db, auth.db, email, true)).toMatchObject({ changed: true });
  } finally {
    await Promise.all([owner.close(), auth.close()]);
  }
}

test('only admins see the admin page', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('not-admin'));
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  const res = await page.goto('/admin/users');
  expect(res?.status()).toBe(404);
});

test('an admin creates invite codes, locks and unlocks a tester, and resets a password', async ({
  page,
  newPage,
}) => {
  const adminEmail = uniqueEmail('admin');
  const testerEmail = uniqueEmail('tester');
  const note = `e2e friends ${Date.now()}`;
  const tester = await newPage();
  await signUpAndVerify(tester, testerEmail, 'Tess Tester');
  await signUpAndVerify(page, adminEmail, 'Ada Admin');
  await makeAdmin(adminEmail);

  await page.goto('/strategy-lab');
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'System health' })).toBeVisible();

  // Invite codes: shown once after creating, then listed by note only.
  await sections(page).getByRole('link', { name: 'Invite codes' }).click();
  await page.getByLabel('How many').fill('2');
  await page.getByLabel('Note (who it is for)').fill(note);
  await page.getByRole('button', { name: 'Create invite codes' }).click();
  const codes = page.getByRole('list', { name: 'New invite codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(2);
  await expect(codes.first()).toHaveText(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
  await page.reload();
  await expect(page.getByRole('row', { name: new RegExp(note) })).toHaveCount(2);
  page.once('dialog', (d) => void d.accept());
  await page
    .getByRole('row', { name: new RegExp(note) })
    .first()
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(
    page.getByRole('row', { name: new RegExp(`${note} Expired or revoked`) }),
  ).toHaveCount(1);

  // Lock the tester: signed out at once and refused at sign-in.
  await sections(page).getByRole('link', { name: 'Users' }).click();
  const row = page.getByRole('row', { name: new RegExp(testerEmail) });
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Lock' }).click();
  await expect(row.getByText('Locked', { exact: true })).toBeVisible();
  await tester.goto('/strategy-lab');
  await expect(tester).toHaveURL(/\/sign-in/);
  await signIn(tester, testerEmail, PASSWORD);
  await expect(tester.locator('main [role=alert]')).toContainText(/account is locked/i);

  // Unlock, then reset their password.
  await row.getByRole('button', { name: 'Unlock' }).click();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await row.getByRole('button', { name: 'Reset password' }).click();
  const temporary = await row
    .getByRole('list', { name: 'Temporary password' })
    .getByRole('listitem')
    .textContent();
  expect(temporary).toMatch(/^[A-Za-z0-9]{20}$/);
  await signIn(tester, testerEmail, PASSWORD);
  await expect(tester.locator('main [role=alert]')).toContainText(/incorrect/i);
  await signIn(tester, testerEmail, temporary ?? '');
  await expect(tester).toHaveURL(/\/strategy-lab$/);

  // Every change is in the audit log, naming the admin.
  await sections(page).getByRole('link', { name: 'Audit log' }).click();
  await page.getByLabel('Show').selectOption('admin.');
  await page.getByRole('button', { name: 'Filter' }).click();
  const log = page.getByRole('table');
  for (const action of ['admin.user_locked', 'admin.user_unlocked', 'admin.password_reset']) {
    await expect(log.getByRole('row', { name: new RegExp(action) }).first()).toContainText(
      `by ${adminEmail}`,
    );
  }
});

test('the admin pages pass automated accessibility checks', async ({ page }) => {
  const email = uniqueEmail('admin-a11y');
  await signUpAndVerify(page, email);
  await makeAdmin(email);
  for (const path of ['/admin', '/admin/users', '/admin/invites', '/admin/audit']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(
      serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  }
});
