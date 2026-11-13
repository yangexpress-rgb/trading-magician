import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The Ask AI panel (N272, ADR 0093): ask any AI agent about the screen you
 * are on. These check what the panel picks up and what it hands over; the
 * agents' own pages are outside the app and are not opened here.
 */

test('picks up the screen and copies a prompt with it for any agent', async ({ page }) => {
  // Keeps what the panel copies, as the test browser's clipboard cannot be read back.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          (window as unknown as { copied: string }).copied = text;
        },
      },
    });
  });
  await signUpAndVerify(page, uniqueEmail('askai'));
  await page.goto('/library/T00001-SD');
  const heading = (await page.getByRole('heading', { level: 1 }).innerText()).trim();

  await page.getByRole('button', { name: 'Ask AI' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask AI' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText(heading).first()).toBeVisible();
  await expect(panel.getByText('Theory T00001-SD')).toBeVisible();

  // Agents with their own page come first; none is connected yet.
  const choices = panel.getByRole('radio');
  await expect(choices).toHaveCount(4);
  await expect(panel.getByText('Not connected')).toHaveCount(3);

  await panel.getByRole('radio', { name: 'Copy prompt' }).check();
  await panel.getByLabel('Your question').fill('What does this theory need to work?');
  await panel.getByRole('button', { name: 'Copy prompt' }).click();
  await expect(panel.getByText('Copied. Paste it into your AI agent.')).toBeVisible();
  const copied = await page.evaluate(() => (window as unknown as { copied: string }).copied);
  expect(copied).toContain('What does this theory need to work?');
  expect(copied).toContain('About: Theory T00001-SD');
  expect(copied).toContain(heading);

  // The panel stays open across pages and picks the new screen up.
  await page.goto('/strategy-lab');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Theory T00001-SD')).toHaveCount(0);

  // Leaving out the page text, then closing.
  await panel.getByLabel('Include the text on this page').uncheck();
  await panel.getByRole('button', { name: /Close/ }).click();
  await expect(panel).toHaveCount(0);
});

test('opens an agent with the question filled in', async ({ page }) => {
  // The agent's page is not loaded in tests: the new tab is stood in for, and
  // the address the panel sends it to is kept.
  await page.addInitScript(() => {
    const w = window as unknown as { sentTo: string[] };
    w.sentTo = [];
    window.open = ((url?: string | URL) => {
      if (url && String(url) !== 'about:blank') w.sentTo.push(String(url));
      return {
        opener: null,
        close: () => undefined,
        location: {
          set href(to: string) {
            w.sentTo.push(to);
          },
        },
      } as unknown as Window;
    }) as typeof window.open;
  });
  await signUpAndVerify(page, uniqueEmail('askai-open'));
  await page.goto('/strategy-lab');
  await page.getByRole('button', { name: 'Ask AI' }).click();
  const panel = page.getByRole('complementary', { name: 'Ask AI' });
  await panel.getByRole('radio', { name: 'Muse' }).check();
  await panel.getByLabel('Your question').fill('Which strategy should I test next?');
  await panel.getByRole('button', { name: 'Ask Muse' }).click();
  await expect(panel.getByText(/Muse opened in a new tab/)).toBeVisible();

  const sentTo = await page.evaluate(() => (window as unknown as { sentTo: string[] }).sentTo);
  expect(sentTo).toHaveLength(1);
  const url = new URL(sentTo[0] ?? '');
  expect(url.origin).toBe('https://muse.ai');
  const prompt = url.searchParams.get('prompt') ?? '';
  expect(prompt).toContain('Which strategy should I test next?');
  expect(prompt).toContain('What I am looking at in Trading Magician');
});
