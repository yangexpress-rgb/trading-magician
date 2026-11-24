'use server';

import { pairCompanion, unpairCompanion, withTenant } from '@tm/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export type PairResult = { ok: true; token: string } | { ok: false; message: string };

/** Pairs a Local Companion (ADR 0116): the token is shown once, here. */
export async function pairResearchCompanion(): Promise<PairResult> {
  const tenant = await requireTenant();
  const { token } = await withTenant(appDb(), tenant, (tx) => pairCompanion(tx, tenant.userId));
  revalidatePath('/settings/research-storage');
  return { ok: true, token };
}

/** Unpairs a companion with immediate effect. */
export async function unpairResearchCompanion(id: string): Promise<void> {
  const tenant = await requireTenant();
  if (!z.uuid().safeParse(id).success) return;
  await withTenant(appDb(), tenant, (tx) => unpairCompanion(tx, tenant.userId, id));
  revalidatePath('/settings/research-storage');
}
