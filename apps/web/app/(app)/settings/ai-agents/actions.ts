'use server';

import {
  AGENT_TOKEN_EXPIRIES,
  clearAiAssistant,
  createTokenConnection,
  listAgentConnections,
  revokeAgentConnection,
  saveAiAssistant,
  withTenant,
  type AgentConnectionSummary,
} from '@tm/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { agentProfile } from '@/lib/agents/profiles';
import { ASK_AI_PROVIDERS, validBaseUrl } from '@/lib/ask-ai';
import { aiSealKey } from '@/lib/server/ai-key';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { requireTenant } from '@/lib/server/session';

export interface MintTokenState {
  status: 'idle' | 'error' | 'created';
  message?: string;
  /** Shown once, here; only its hash is stored. */
  token?: string;
  connection?: AgentConnectionSummary;
}

const mintForm = z.object({
  profileId: z.string().refine((id) => {
    const p = agentProfile(id);
    return p?.authMethod === 'token' || p?.tokenFallback === true;
  }, 'Pick an agent'),
  name: z.string().trim().min(1, 'Name the token').max(80, 'Use 80 characters or fewer'),
  scope: z.enum(['read', 'operate']),
  expiry: z.enum(AGENT_TOKEN_EXPIRIES),
});

/** Mints an agent token (brief §2b, §3c). */
export async function mintAgentToken(
  _prev: MintTokenState,
  form: FormData,
): Promise<MintTokenState> {
  const tenant = await requireTenant();
  if (!serverEnv().AGENT_API_ENABLED) {
    return { status: 'error', message: 'Agent connections are turned off on this server.' };
  }
  const parsed = mintForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form' };
  }
  const { token, connection } = await withTenant(appDb(), tenant, (tx) =>
    createTokenConnection(tx, tenant.userId, parsed.data),
  );
  revalidatePath('/settings/ai-agents');
  return { status: 'created', token, connection };
}

export type ConnectWithKeyResult = { ok: true; token: string } | { ok: false; message: string };

/**
 * Layer 1 Connect for agents that take a key (Claude Code, another agent):
 * makes one with the plain defaults (named after the agent, ends in 90
 * days). Errors say what happened and what to do next; no codes here.
 */
export async function connectWithKey(
  profileId: string,
  scope: 'read' | 'operate',
): Promise<ConnectWithKeyResult> {
  const tenant = await requireTenant();
  if (!serverEnv().AGENT_API_ENABLED) {
    return {
      ok: false,
      message: 'Connecting agents is switched off on this server for now. Try again later.',
    };
  }
  const profile = agentProfile(profileId);
  if (!profile || profile.connect.kind !== 'key' || !['read', 'operate'].includes(scope)) {
    return {
      ok: false,
      message: 'That agent cannot connect this way. Reload the page and try again.',
    };
  }
  const { token } = await withTenant(appDb(), tenant, (tx) =>
    createTokenConnection(tx, tenant.userId, {
      profileId,
      name: profile.displayName,
      scope,
      expiry: '90d',
    }),
  );
  revalidatePath('/settings/ai-agents');
  return { ok: true, token };
}

/** Layer 1 Disconnect: ends every active connection of one agent at once. */
export async function disconnectAgent(profileId: string): Promise<void> {
  const tenant = await requireTenant();
  await withTenant(appDb(), tenant, async (tx) => {
    for (const c of await listAgentConnections(tx)) {
      if (c.profileId === profileId && c.status === 'active') {
        await revokeAgentConnection(tx, tenant.userId, c.id);
      }
    }
  });
  revalidatePath('/settings/ai-agents');
}

/** Revokes a connection with immediate effect. */
export async function revokeAgent(id: string): Promise<void> {
  const tenant = await requireTenant();
  if (!z.uuid().safeParse(id).success) return;
  await withTenant(appDb(), tenant, (tx) => revokeAgentConnection(tx, tenant.userId, id));
  revalidatePath('/settings/ai-agents');
}

export interface AskAiAgentState {
  status: 'idle' | 'error' | 'saved';
  message?: string;
}

const askAiForm = z
  .object({
    provider: z.enum(['muse', 'anthropic', 'openai', 'openai_compatible'], {
      message: 'Pick an agent',
    }),
    model: z.string().trim().max(120, 'Use 120 characters or fewer').optional(),
    baseUrl: z.string().trim().max(500).optional(),
    apiKey: z.string().trim().max(400, 'That key is too long').optional(),
  })
  .superRefine((v, ctx) => {
    const provider = ASK_AI_PROVIDERS.find((p) => p.id === v.provider);
    if (provider?.needsModel && !v.model) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'Name the model' });
    }
    if (v.provider === 'openai_compatible' && !(v.baseUrl && validBaseUrl(v.baseUrl))) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'Enter the API address, starting with https://',
      });
    }
    if (v.apiKey && v.apiKey.length < 8) {
      ctx.addIssue({ code: 'custom', path: ['apiKey'], message: 'That key is too short' });
    }
  });

/** Chooses the person's one Ask AI agent (N274). */
export async function saveAskAiAgent(
  _prev: AskAiAgentState,
  form: FormData,
): Promise<AskAiAgentState> {
  const tenant = await requireTenant();
  const value = (k: string) => {
    const v = form.get(k);
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const parsed = askAiForm.safeParse({
    provider: value('provider'),
    model: value('model'),
    baseUrl: value('baseUrl'),
    apiKey: value('apiKey'),
  });
  if (!parsed.success) {
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Check the form' };
  }
  try {
    await withTenant(appDb(), tenant, (tx) =>
      saveAiAssistant(
        tx,
        tenant.userId,
        {
          provider: parsed.data.provider,
          model: parsed.data.model ?? null,
          baseUrl: parsed.data.baseUrl ?? null,
          ...(parsed.data.apiKey ? { apiKey: parsed.data.apiKey } : {}),
        },
        aiSealKey(),
      ),
    );
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : 'The agent could not be saved.',
    };
  }
  revalidatePath('/', 'layout');
  return { status: 'saved', message: 'Saved. Ask AI now uses this agent.' };
}

/** Forgets the person's Ask AI agent and its key (N274). */
export async function clearAskAiAgent(): Promise<void> {
  const tenant = await requireTenant();
  await withTenant(appDb(), tenant, (tx) => clearAiAssistant(tx, tenant.userId));
  revalidatePath('/', 'layout');
}
