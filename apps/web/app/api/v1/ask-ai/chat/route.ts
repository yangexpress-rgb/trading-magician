import { isLinkProvider, loadAiAssistantSecret } from '@tm/db';
import { CHAT_SYSTEM_PROMPT, chatRequest, screenBlock } from '@/lib/ask-ai';
import { aiSealKey } from '@/lib/server/ai-key';
import { api, errorResponse, readJson } from '@/lib/server/api';
import { ChatError, DEFAULT_MODELS, runChat } from '@/lib/server/ask-ai/chat';
import { askAiTools } from '@/lib/server/ask-ai/tools';
import { serverEnv } from '@/lib/server/env';

export const dynamic = 'force-dynamic';
// An answer may take several tool calls.
export const maxDuration = 300;

/**
 * One turn of the Ask AI chat (N274, ADR 0094): the person's messages and
 * screen go to their own AI agent with the app's agent tools, and the answer
 * comes back with the tools it used.
 */
export const POST = api(async (request, { tx, userId }) => {
  const body = await readJson(request, chatRequest);
  const agent = await tx((t) => loadAiAssistantSecret(t, userId, aiSealKey()));
  if (!agent || isLinkProvider(agent.provider)) {
    return errorResponse(
      'invalid_state',
      'Choose an AI agent with an API key in Settings › AI agents to chat here.',
    );
  }
  if (!agent.apiKey) {
    return errorResponse(
      'invalid_state',
      "Your AI agent's key can no longer be read. Enter it again in Settings › AI agents.",
    );
  }
  const model = agent.model || DEFAULT_MODELS[agent.provider];
  if (!model) {
    return errorResponse('invalid_state', 'Name the model in Settings › AI agents.');
  }
  const turns = body.turns.map((t, i) =>
    i === body.turns.length - 1 && body.screen
      ? { role: t.role, content: `${t.content}\n\n${screenBlock(body.screen)}` }
      : t,
  );
  try {
    const result = await runChat(
      { provider: agent.provider, model, apiKey: agent.apiKey, baseUrl: agent.baseUrl },
      { system: CHAT_SYSTEM_PROMPT, turns, tools: askAiTools(userId, serverEnv().APP_URL) },
    );
    return Response.json(result);
  } catch (error) {
    if (error instanceof ChatError) return errorResponse('unavailable', error.message);
    throw error;
  }
});
