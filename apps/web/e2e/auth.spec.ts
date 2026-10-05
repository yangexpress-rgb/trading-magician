import { expect } from '@playwright/test';
import {
  formAlert,
  NEW_PASSWORD,
  PASSWORD,
  signIn,
  signUpAndVerify,
  test,
  uniqueEmail,
} from './fixtures';
import { latestLink } from './mail';

test('unauthenticated visitors are sent to sign in', async ({ page }) => {
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('sign up, verify email, and land in a provisioned paper workspace', async ({ page }) => {
  const email = uniqueEmail('signup');
  await signUpAndVerify(page, email);

  await expect(page.getByText('Paper trading mode')).toBeAttached();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: 'Trading platforms and accounts' }).click();
  const demo = page
    .getByRole('list', { name: 'Trading platforms' })
    .getByRole('listitem', { name: 'Demo paper broker' });
  await expect(demo.getByText('Paper', { exact: true })).toBeVisible();
  await expect(demo.getByRole('row', { name: /Demo paper account/ })).toContainText('Default');
  await page.getByRole('link', { name: 'Data feeds' }).click();
  await expect(
    page.getByRole('list', { name: 'Data feeds' }).getByRole('listitem', { name: 'Demo feed' }),
  ).toBeVisible();
});

test('unverified users cannot sign in', async ({ page }) => {
  const email = uniqueEmail('unverified');
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Unverified');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await signIn(page, email, PASSWORD);
  await expect(formAlert(page)).toContainText('Verify your email first');
});

test('profile changes persist and are validated', async ({ page }) => {
  const email = uniqueEmail('profile');
  await signUpAndVerify(page, email);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings\/profile$/);

  await page.getByLabel('Display name').fill('Renamed Trader');
  await page.getByLabel('Time zone').selectOption('Asia/Tokyo');
  await page.getByLabel('Base currency').selectOption('EUR');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toHaveText('Profile saved.');

  await page.reload();
  await expect(page.getByLabel('Display name')).toHaveValue('Renamed Trader');
  await expect(page.getByLabel('Time zone')).toHaveValue('Asia/Tokyo');
  await expect(page.getByLabel('Base currency')).toHaveValue('EUR');
});

test('password reset signs out other sessions and accepts the new password', async ({
  page,
  newPage,
}) => {
  const email = uniqueEmail('reset');
  await signUpAndVerify(page, email);

  const other = await newPage();
  await other.goto('/forgot-password');
  await other.getByLabel('Email').fill(email);
  await other.getByRole('button', { name: 'Send reset link' }).click();
  await expect(other.getByText(/If an account exists/)).toBeVisible();

  await other.goto(await latestLink(email, /Reset/));
  await other.getByLabel(/New password/).fill(NEW_PASSWORD);
  await other.getByRole('button', { name: 'Save password' }).click();
  await expect(other).toHaveURL(/\/sign-in\?reset=1$/);

  await signIn(other, email, PASSWORD);
  await expect(formAlert(other)).toContainText('incorrect');
  await signIn(other, email, NEW_PASSWORD);
  await expect(other).toHaveURL(/\/strategy-lab$/);

  // The original session was revoked by the reset.
  await page.goto('/settings/profile');
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('sessions can be listed and revoked', async ({ page, newPage }) => {
  const email = uniqueEmail('sessions');
  await signUpAndVerify(page, email);

  const second = await newPage();
  await signIn(second, email, PASSWORD);
  await expect(second).toHaveURL(/\/strategy-lab$/);

  await page.goto('/settings/security');
  await expect(page.getByText('This device')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out all other devices' }).click();
  await expect(page.getByRole('button', { name: 'Sign out all other devices' })).toHaveCount(0);

  await second.goto('/settings/profile');
  await expect(second).toHaveURL(/\/sign-in$/);
});

test('account deletion requires confirmation and removes access', async ({ page }) => {
  const email = uniqueEmail('delete');
  await signUpAndVerify(page, email);
  await page.goto('/settings/security');

  await page.getByRole('button', { name: 'Delete account…' }).click();
  const form = page.getByRole('form', { name: 'Delete account' });
  await form.getByLabel('Password').fill(PASSWORD);
  await form.getByLabel('Type DELETE to confirm').fill('delete');
  await form.getByRole('button', { name: 'Permanently delete my account' }).click();
  await expect(formAlert(page)).toHaveText('Type DELETE to confirm.');

  await form.getByLabel('Type DELETE to confirm').fill('DELETE');
  await form.getByRole('button', { name: 'Permanently delete my account' }).click();
  await expect(page).toHaveURL(/\/sign-in\?deleted=1$/);

  await signIn(page, email, PASSWORD);
  await expect(formAlert(page)).toContainText('incorrect');
});

test('repeated failed sign-ins are rate limited', async ({ page, baseURL }) => {
  const email = uniqueEmail('ratelimit');
  let limited = false;
  for (let i = 0; i < 12 && !limited; i++) {
    const res = await page.request.post('/api/auth/sign-in/email', {
      data: { email, password: 'wrong password 123' },
      headers: { origin: baseURL ?? '' },
    });
    limited = res.status() === 429;
  }
  expect(limited).toBe(true);
});
