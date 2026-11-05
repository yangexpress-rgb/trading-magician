import { expect } from '@playwright/test';
import { createDb, mintInvites } from '@tm/db';
import { test, PASSWORD, uniqueEmail } from './fixtures';
import { latestLink } from './mail';

/**
 * The controlled launch (§16.4, ADR 0026). This project runs against a second
 * server with SIGNUP_MODE=invite; the rest of the suite signs up without a code.
 */

async function mintCode(): Promise<string> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint an invite code');
  const { db, close } = createDb(url, { max: 1 });
  try {
    const [code] = await mintInvites(db, 1, { note: 'e2e' });
    if (!code) throw new Error('no code minted');
    return code;
  } finally {
    await close();
  }
}

test('sign-up needs an unused invite code, and each code admits one person', async ({
  page,
  newPage,
}) => {
  const code = await mintCode();

  await page.goto('/sign-up');
  await expect(page.getByLabel('Invite code')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();

  // A code nobody minted is refused, and says so without saying why.
  await page.getByLabel('Name').fill('Uninvited');
  await page.getByLabel('Invite code').fill('ZZZZ-ZZZZ-ZZZZ-ZZZZ');
  await page.getByLabel('Email').fill(uniqueEmail('uninvited'));
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.locator('main [role=alert]')).toContainText(/invite code is not valid/i);

  // The real code works, typed in lower case and with spaces instead of dashes.
  const email = uniqueEmail('invited');
  await page.getByLabel('Invite code').fill(code.toLowerCase().replace(/-/g, ' '));
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await latestLink(email, /Verify/));
  await expect(page).toHaveURL(/\/strategy-lab$/);
  await expect(page.getByText(/Paper trading only/)).toBeVisible();

  // The same code cannot admit a second person.
  const second = await newPage();
  await second.goto('/sign-up');
  await second.getByLabel('Name').fill('Second');
  await second.getByLabel('Invite code').fill(code);
  await second.getByLabel('Email').fill(uniqueEmail('second'));
  await second.getByLabel(/^Password/).fill(PASSWORD);
  await second.getByRole('button', { name: 'Create account' }).click();
  await expect(second.locator('main [role=alert]')).toContainText(
    /not valid or has already been used/i,
  );
});

test('the terms and privacy pages are public and say what the app is not', async ({
  playwright,
  baseURL,
}) => {
  const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
  for (const path of ['/terms', '/privacy']) {
    const res = await anonymous.get(path);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('Paper trading only');
  }
  await anonymous.dispose();
});
