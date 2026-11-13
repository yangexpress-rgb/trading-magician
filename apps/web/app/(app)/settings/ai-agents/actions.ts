'use server';

import {
  AGENT_TOKEN_EXPIRIES,
  createTokenConnection,
  listAgentConnections,
  revokeAgentConnection,
  withTenant,
  type AgentConnectionSummary,
} from '@tm/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { agentProfile } from '@/lib/agents/profiles';
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
