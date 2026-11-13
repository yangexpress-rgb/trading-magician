'use server';

import {
  AGENT_TOKEN_EXPIRIES,
  createTokenConnection,
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
  profileId: z.string().refine((id) => agentProfile(id)?.authMethod === 'token', 'Pick an agent'),
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

/** Revokes a connection with immediate effect. */
export async function revokeAgent(id: string): Promise<void> {
  const tenant = await requireTenant();
  if (!z.uuid().safeParse(id).success) return;
  await withTenant(appDb(), tenant, (tx) => revokeAgentConnection(tx, tenant.userId, id));
  revalidatePath('/settings/ai-agents');
}
