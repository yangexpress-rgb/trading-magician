import { expect, test } from '@playwright/test';
import { signUpAndVerify, test as appTest, uniqueEmail } from './fixtures';

// N250: the app installs as its own window (Chrome "Install", Safari "Add to Dock").
test.describe('installable app', () => {
  test('manifest and icons load without signing in', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest.name).toBe('Trading Magician');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/tabs');
    const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const icon of [
      ...manifest.icons.map((i: { src: string }) => i.src),
      '/apple-icon.png',
      '/icon.svg',
    ]) {
      const r = await request.get(icon, { maxRedirects: 0 });
      expect(r.status(), icon).toBe(200);
    }
  });

  test('Chrome finds no installability errors', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chrome DevTools protocol only');
    await page.goto('/sign-in');
    await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
    const cdp = await page.context().newCDPSession(page);
    await expect
      .poll(async () => {
        const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
        // Some Chromium builds treat test contexts as incognito, where nothing installs.
        return installabilityErrors.map((e) => e.errorId).filter((id) => id !== 'in-incognito');
      })
      .toEqual([]);
  });
});

// N252: the sidebar offers the desktop app; without the browser's prompt it explains the steps.
appTest('sidebar Install desktop app explains how to install', async ({ page }) => {
  // Headless Chromium may offer its own install prompt; hide it to test the help path.
  await page.addInitScript(() =>
    window.addEventListener('beforeinstallprompt', (e) => e.stopImmediatePropagation(), true),
  );
  await signUpAndVerify(page, uniqueEmail('install'));
  await page.goto('/strategy-lab');
  await page.getByRole('button', { name: 'Install desktop app' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install the desktop app' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Chrome');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

// N253: the installed app's window has tabs; Cmd/Ctrl-click opens a link in a new tab.
appTest('installed app opens pages in tabs', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('tabs'));
  // Act as the installed app's window from here on.
  await page.addInitScript(() => {
    window.__tmAppMode = true;
  });
  await page.goto('/strategy-lab');
  await expect(page).toHaveURL(/\/tabs\?open=%2Fstrategy-lab/);
  const tabs = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveText('Strategy Lab');

  // Ctrl-click a sidebar link inside the tab: it opens behind, as in a browser.
  const first = page.frameLocator('iframe[role="tabpanel"]').first();
  await first
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Orders' })
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText('Orders');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // A plain click navigates inside the tab, and the tab follows its title.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(tabs).toHaveCount(3);
  await page
    .getByRole('button', { name: /^Close tab / })
    .last()
    .click();
  await expect(tabs).toHaveCount(2);

  // Right-click on a link opens it in a new tab in front (N254).
  const current = page.frameLocator('iframe[role="tabpanel"]:not(.invisible)');
  await current
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Performance' })
    .click({ button: 'right' });
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toHaveText('Performance');
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Close tab Performance' }).click();
  await expect(tabs).toHaveCount(2);

  // Tabs come back when the app is opened again.
  await page.goto('/tabs');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText('Orders');
});
