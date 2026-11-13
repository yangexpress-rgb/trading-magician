import { describe, expect, it } from 'vitest';
import { ChatError, MAX_TOOL_ROUNDS, runChat, type ChatTools } from './chat';

const tools = (calls: { name: string; args: unknown }[]): ChatTools => ({
  list: [
    {
      name: 'list_strategies',
      description: 'Lists strategies',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  run: async (name, args) => {
    calls.push({ name, args });
    return name === 'list_strategies'
      ? { ok: true, text: JSON.stringify({ items: [{ number: 'S00001-SD' }] }) }
      : { ok: false, text: JSON.stringify({ error: 'Unknown tool' }) };
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('runChat with an OpenAI-compatible service', () => {
  it('runs the tools the agent calls, then returns its answer and the steps', async () => {
    const sent: Record<string, unknown>[] = [];
    const replies = [
      json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'list_strategies', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
      json({ choices: [{ message: { role: 'assistant', content: 'You have S00001-SD.' } }] }),
    ];
    const calls: { name: string; args: unknown }[] = [];
    const result = await runChat(
      {
        provider: 'openai_compatible',
        model: 'm',
        apiKey: 'sk-test-1234',
        baseUrl: 'https://ai.example/v1/',
      },
      {
        system: 'SYS',
        turns: [{ role: 'user', content: 'What do I have?' }],
        tools: tools(calls),
        fetch: (async (url: string, init: RequestInit) => {
          expect(url).toBe('https://ai.example/v1/chat/completions');
          expect((init.headers as Record<string, string>).authorization).toBe(
            'Bearer sk-test-1234',
          );
          sent.push(JSON.parse(init.body as string) as Record<string, unknown>);
          return replies.shift();
        }) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({
      reply: 'You have S00001-SD.',
      steps: [{ tool: 'list_strategies', ok: true }],
    });
    expect(calls).toEqual([{ name: 'list_strategies', args: {} }]);
    expect(sent[0]?.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'What do I have?' },
    ]);
    const second = sent[1]?.messages as { role: string; content: string }[];
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
  });

  it('explains a refused key in plain words', async () => {
    const run = runChat(
      { provider: 'openai', model: 'm', apiKey: 'bad-key-0000' },
      {
        system: 'S',
        turns: [{ role: 'user', content: 'Hi' }],
        tools: tools([]),
        fetch: (async () =>
          json({ error: { message: 'bad key' } }, 401)) as unknown as typeof fetch,
      },
    );
    await expect(run).rejects.toThrow(ChatError);
    await expect(run).rejects.toThrow(/refused the API key/);
  });

  it('stops an agent that only calls tools', async () => {
    const toolCall = () =>
      json({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c',
                  type: 'function',
                  function: { name: 'list_strategies', arguments: '{}' },
                },
              ],
            },
          },
        ],
      });
    const calls: { name: string; args: unknown }[] = [];
    let requests = 0;
    const run = runChat(
      { provider: 'openai', model: 'm', apiKey: 'k-12345678' },
      {
        system: 'S',
        turns: [{ role: 'user', content: 'Hi' }],
        tools: tools(calls),
        fetch: (async (_url: string, init: RequestInit) => {
          requests++;
          const body = JSON.parse(init.body as string) as { tools?: unknown };
          // The last round offers no tools, so a well-behaved agent must answer.
          if (requests === MAX_TOOL_ROUNDS + 1) expect(body.tools).toBeUndefined();
          return toolCall();
        }) as unknown as typeof fetch,
      },
    );
    await expect(run).rejects.toThrow(/kept calling tools/);
    expect(requests).toBe(MAX_TOOL_ROUNDS + 1);
  });
});

describe('runChat with Claude', () => {
  it('sends the tools, runs a tool_use and returns the final text', async () => {
    const bodies: Record<string, unknown>[] = [];
    const replies = [
      json({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'tu1', name: 'list_strategies', input: {} },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      json({
        id: 'm2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'You have one strategy.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ];
    const calls: { name: string; args: unknown }[] = [];
    const result = await runChat(
      { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-test' },
      {
        system: 'SYS',
        turns: [{ role: 'user', content: 'Count my strategies' }],
        tools: tools(calls),
        fetch: (async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
          return replies.shift();
        }) as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({
      reply: 'You have one strategy.',
      steps: [{ tool: 'list_strategies', ok: true }],
    });
    expect(bodies[0]).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'SYS',
      fallbacks: 'default',
      tools: [{ name: 'list_strategies' }],
    });
    const second = bodies[1]?.messages as { role: string; content: unknown }[];
    expect(second.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu1',
          content: JSON.stringify({ items: [{ number: 'S00001-SD' }] }),
          is_error: false,
        },
      ],
    });
  });
});
