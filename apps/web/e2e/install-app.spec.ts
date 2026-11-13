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
    expect(manifest.start_url).toBe('/strategy-lab');
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
        return installabilityErrors.map((e) => e.errorId);
      })
      .toEqual([]);
  });
});

// N251: the sidebar offers the desktop app; without the browser's prompt it explains the steps.
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
