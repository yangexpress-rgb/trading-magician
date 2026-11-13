import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * The Ask AI panel (N272, N274; ADR 0093, 0094): a chat with the one AI agent
 * the person chose in Settings › AI agents. A stand-in OpenAI-compatible
 * service on this machine plays the agent; Muse's own page is not opened.
 */

interface SeenRequest {
  model: string;
  messages: { role: string; content: string | null; tool_call_id?: string }[];
  tools?: unknown[];
}

let server: Server;
let baseUrl: string;
const seen: SeenRequest[] = [];

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest;
      seen.push(body);
      const toolResult = body.messages.find((m) => m.role === 'tool');
      const reply = toolResult
        ? {
            role: 'assistant',
            content: `You have ${(JSON.parse(toolResult.content ?? '{}') as { total?: number }).total ?? 0} strategies.`,
          }
        : {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'list_strategies', arguments: '{}' },
              },
            ],
          };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: reply }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

test.afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Ask AI' }).click();
  return page.getByRole('complementary', { name: /^Ask / });
}

test('chats with the chosen agent about the screen, using the app tools', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('askai-chat'));

  // Before an agent is chosen, the panel points to Settings.
  await page.goto('/strategy-lab');
  let panel = await openPanel(page);
  await expect(panel.getByRole('link', { name: /Choose your agent/ })).toBeVisible();

  await page.goto('/settings/ai-agents');
  const card = page.locator('#ask-ai');
  // Checked again until the page has hydrated and shows the service's fields.
  await expect(async () => {
    await card.getByRole('radio', { name: /Another AI service/ }).check();
    await expect(card.getByRole('textbox', { name: 'API address' })).toBeVisible({
      timeout: 1000,
    });
  }).toPass();
  await card.getByRole('textbox', { name: 'API key' }).fill('sk-test-key-1234');
  await card.getByRole('textbox', { name: 'API address' }).fill(baseUrl);
  await card.getByRole('textbox', { name: 'Model', exact: true }).fill('test-model');
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved. Ask AI now uses this agent.')).toBeVisible();

  await page.goto('/library/T00001-SD');
  panel = page.getByRole('complementary', { name: 'Ask Another AI service' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Theory T00001-SD')).toBeVisible();
  await panel.getByLabel(/Message to/).fill('How many strategies do I have?');
  await panel.getByRole('button', { name: 'Send' }).click();

  await expect(panel.getByText('How many strategies do I have?')).toBeVisible();
  await expect(panel.getByText(/You have \d+ strategies\./)).toBeVisible();
  await expect(panel.getByText('listed strategies')).toBeVisible();

  // The agent got the screen with the question, and the tools.
  const first = seen[0];
  expect(first?.model).toBe('test-model');
  expect(first?.tools?.length).toBeGreaterThan(5);
  const asked = first?.messages.at(-1)?.content ?? '';
  expect(asked).toContain('How many strategies do I have?');
  expect(asked).toContain('<screen>');
  expect(asked).toContain('Theory T00001-SD');

  // A follow-up carries the conversation so far.
  await panel.getByLabel(/Message to/).fill('Thanks');
  await panel.getByLabel(/Message to/).press('Enter');
  await expect(panel.getByText('Thanks')).toBeVisible();
  await expect.poll(() => seen.length).toBeGreaterThanOrEqual(4);
  const followUp = seen[2]?.messages.map((m) => m.role);
  expect(followUp?.slice(0, 4)).toEqual(['system', 'user', 'assistant', 'user']);

  // The panel's tool calls show in Activity.
  await page.goto('/settings/ai-agents#activity');
  await expect(page.getByText('Ask AI panel').first()).toBeVisible();

  // New chat starts afresh.
  panel = page.getByRole('complementary', { name: /^Ask / });
  await panel.getByRole('button', { name: 'New chat' }).click();
  await expect(panel.getByText('How many strategies do I have?')).toHaveCount(0);
});

test('with Muse chosen, Ask Muse opens Muse with the question filled in', async ({ page }) => {
  // Muse's page is not loaded in tests: the new tab is stood in for, and the
  // address the panel sends it to is kept.
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
  await signUpAndVerify(page, uniqueEmail('askai-muse'));
  await page.goto('/settings/ai-agents');
  const card = page.locator('#ask-ai');
  await card.getByRole('radio', { name: /Muse/ }).check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Saved. Ask AI now uses this agent.')).toBeVisible();

  await page.goto('/strategy-lab');
  const panel = await openPanel(page);
  await expect(panel.getByRole('heading', { name: 'Ask Muse' })).toBeVisible();
  await panel.getByLabel(/Message to/).fill('Which strategy should I test next?');
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
