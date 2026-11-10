import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

const TABS = [
  { name: 'Quantitative Research', path: '/research' },
  { name: 'Trading Strategy', path: '/strategy-lab' },
  { name: 'Orders', path: '/orders' },
  { name: 'Performance', path: '/performance' },
  { name: 'Settings', path: '/settings/profile' },
];

const OTHER_PAGES = [
  '/library',
  '/sharing',
  '/library/new',
  '/library/T00001-SD',
  '/library/T00001-SD/edit',
  '/settings/data-feeds',
  '/settings/accounts',
  '/settings/billing',
  '/settings/security',
  '/notifications',
];

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

test('shows the five tabs in the specified order and marks the current one', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('nav'));
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link')).toHaveText(TABS.map((t) => t.name));

  for (const tab of TABS) {
    await nav.getByRole('link', { name: tab.name }).click();
    await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
    await expect(nav.getByRole('link', { name: tab.name })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

test('Trading Strategy holds Strategy Lab, Theory Library and Sharing as tabs under its title', async ({
  page,
}) => {
  await signUpAndVerify(page, uniqueEmail('trading-tabs'));
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Trading Strategy' }).click();
  await expect(page).toHaveURL(/\/strategy-lab$/);
  const tabs = page.getByRole('navigation', { name: 'Trading Strategy' });
  await expect(tabs.getByRole('link')).toHaveText(['Strategy Lab', 'Theory Library', 'Sharing']);
  for (const [name, path] of [
    ['Strategy Lab', '/strategy-lab'],
    ['Sharing', '/sharing'],
    ['Theory Library', '/library'],
  ] as const) {
    await tabs.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(tabs.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Trading Strategy' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The page title is "Trading Strategy" and the tabs sit under it, as in Research (N194).
    await expect(page.getByRole('heading', { level: 1, name: 'Trading Strategy' })).toBeVisible();
  }
  await page.screenshot({ path: 'test-results/trading-strategy-tabs.png' });
});

test('every signed-in page passes automated accessibility checks', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('a11y'));
  for (const path of [...TABS.map((t) => t.path), ...OTHER_PAGES]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectAccessible(page);
  }
});

test('auth pages pass automated accessibility checks', async ({ page }) => {
  for (const path of ['/sign-in', '/sign-up', '/forgot-password']) {
    await page.goto(path);
    await expectAccessible(page);
  }
});

test('pages are served with a nonce-based Content Security Policy and run without violations', async ({
  page,
}) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  const response = await page.goto('/sign-in');
  const csp = response?.headers()['content-security-policy'] ?? '';
  expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");

  // The page must hydrate under the policy: client-side validation and handlers work.
  await signUpAndVerify(page, uniqueEmail('csp'));
  await page.goto('/settings/profile');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByRole('status')).toHaveText('Profile saved.');
  expect(violations).toEqual([]);
});

test('the navigation stays usable on a phone-width screen', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 740 });
  await signUpAndVerify(page, uniqueEmail('mobile'));
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Orders' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
