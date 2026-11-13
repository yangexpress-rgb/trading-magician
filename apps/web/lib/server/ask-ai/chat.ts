import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider, LinkProvider } from '@tm/db';

/**
 * The Ask AI chat loop (N274, ADR 0094): one turn of a conversation with the
 * person's own AI agent, which may call the app's agent tools (ADR 0092)
 * before it answers. Anthropic goes through the official SDK; OpenAI and
 * OpenAI-compatible services through their Chat Completions API. Muse and the
 * claude.ai plan have no API for the app, so they never reach this loop.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatStep {
  tool: string;
  ok: boolean;
}

export interface ChatResult {
  reply: string;
  steps: ChatStep[];
}

export interface ChatTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatTools {
  list: readonly ChatTool[];
  /** Runs a tool; the text goes back to the agent. */
  run: (name: string, args: unknown) => Promise<{ ok: boolean; text: string }>;
}

export interface ChatAgent {
  provider: Exclude<AiProvider, LinkProvider>;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
}

export class ChatError extends Error {
  override name = 'ChatError';
}

/** Tool rounds before the agent must answer. */
export const MAX_TOOL_ROUNDS = 8;

export const DEFAULT_MODELS: Record<ChatAgent['provider'], string> = {
  anthropic: 'claude-opus-5-5',
  openai: '',
  openai_compatible: '',
};

/** Claude models that take the server-side refusal fallback. */
const FALLBACK_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-fable-5-2',
]);

export function runChat(
  agent: ChatAgent,
  input: { system: string; turns: readonly ChatTurn[]; tools: ChatTools; fetch?: typeof fetch },
): Promise<ChatResult> {
  return agent.provider === 'anthropic' ? runAnthropic(agent, input) : runOpenAi(agent, input);
}

async function runAnthropic(
  agent: ChatAgent,
  input: { system: string; turns: readonly ChatTurn[]; tools: ChatTools; fetch?: typeof fetch },
): Promise<ChatResult> {
  const client = new Anthropic({
    apiKey: agent.apiKey,
    maxRetries: 1,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const tools: Anthropic.Beta.BetaTool[] = input.tools.list.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = input.turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));
  const steps: ChatStep[] = [];
  const fallback = FALLBACK_MODELS.has(agent.model);
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: agent.model,
        max_tokens: 16000,
        system: input.system,
        messages,
        // The last round leaves tools out, so the agent answers with what it has.
        ...(round < MAX_TOOL_ROUNDS ? { tools } : {}),
        ...(fallback
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      });
    } catch (error) {
      throw new ChatError(anthropicErrorText(error));
    }
    if (response.stop_reason === 'refusal') {
      return { reply: 'Claude declined to answer that. Try asking another way.', steps };
    }
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;
    const uses = response.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
    );
    if (response.stop_reason !== 'tool_use' || uses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim();
      return { reply: text || '(No answer.)', steps };
    }
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const r = await input.tools.run(use.name, use.input);
      steps.push({ tool: use.name, ok: r.ok });
      results.push({ type: 'tool_result', tool_use_id: use.id, content: r.text, is_error: !r.ok });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new ChatError('The agent kept calling tools without answering. Try a narrower question.');
}

function anthropicErrorText(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'Claude refused the API key. Check it in Settings › AI agents.';
  }
  if (error instanceof Anthropic.NotFoundError) {
    return 'Claude does not know that model. Check the model in Settings › AI agents.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Claude is rate limiting this key. Wait a moment and try again.';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Claude could not take the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `Claude did not answer (error ${error.status ?? 'unknown'}). Try again.`;
  }
  return 'Claude could not be reached. Try again.';
}

// ---------------------------------------------------------------------------
// OpenAI and OpenAI-compatible services (Chat Completions)

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

async function runOpenAi(
  agent: ChatAgent,
  input: { system: string; turns: readonly ChatTurn[]; tools: ChatTools; fetch?: typeof fetch },
): Promise<ChatResult> {
  const doFetch = input.fetch ?? fetch;
  const base = (agent.provider === 'openai' ? OPENAI_BASE_URL : (agent.baseUrl ?? '')).replace(
    /\/+$/,
    '',
  );
  const tools = input.tools.list.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
  const messages: OpenAiMessage[] = [
    { role: 'system', content: input.system },
    ...input.turns.map((t) => ({ role: t.role, content: t.content })),
  ];
  const steps: ChatStep[] = [];
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let res: Response;
    try {
      res = await doFetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.apiKey}` },
        body: JSON.stringify({
          model: agent.model,
          messages,
          ...(round < MAX_TOOL_ROUNDS ? { tools } : {}),
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch {
      throw new ChatError(`The agent at ${new URL(base).host} could not be reached. Try again.`);
    }
    const body = (await res.json().catch(() => null)) as {
      choices?: { message?: OpenAiMessage; finish_reason?: string }[];
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ChatError('The agent refused the API key. Check it in Settings › AI agents.');
      }
      throw new ChatError(
        `The agent did not answer (error ${res.status}${body?.error?.message ? `: ${body.error.message.slice(0, 200)}` : ''}).`,
      );
    }
    const message = body?.choices?.[0]?.message;
    if (!message) throw new ChatError('The agent sent an answer the app could not read.');
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return { reply: (message.content ?? '').trim() || '(No answer.)', steps };
    }
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    for (const call of calls) {
      let args: unknown = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        args = null;
      }
      const r =
        args === null
          ? { ok: false, text: JSON.stringify({ error: 'The arguments were not valid JSON.' }) }
          : await input.tools.run(call.function.name, args);
      steps.push({ tool: call.function.name, ok: r.ok });
      messages.push({ role: 'tool', tool_call_id: call.id, content: r.text });
    }
  }
  throw new ChatError('The agent kept calling tools without answering. Try a narrower question.');
}
