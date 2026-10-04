import { expect, test as base, type Page } from '@playwright/test';
import { latestLink } from './mail';

/**
 * Each browser context gets its own client IP so per-IP auth rate limits (which
 * stay enabled in tests) apply per simulated visitor rather than to the suite.
 */
export const test = base.extend<{ newPage: () => Promise<Page> }>({
  newPage: async ({ browser, baseURL }, use) => {
    const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
    await use(async () => {
      const ip = `10.${rand()}.${rand()}.${rand()}`;
      const context = await browser.newContext({
        ...(baseURL ? { baseURL } : {}),
        extraHTTPHeaders: { 'x-forwarded-for': ip },
      });
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
  page: async ({ newPage }, use) => use(await newPage()),
});
const rand = () => Math.floor(Math.random() * 254) + 1;
export const formAlert = (page: Page) => page.locator('main [role=alert]');

export const PASSWORD = 'correct horse battery';
export const NEW_PASSWORD = 'staple battery horse';
export const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;

export async function signUpAndVerify(page: Page, email: string, name = 'Test Trader') {
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await latestLink(email, /Verify/));
  await expect(page).toHaveURL(/\/strategy-lab$/);
}

export async function signIn(page: Page, email: string, password: string) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
