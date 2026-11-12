'use server';

import {
  AdminError,
  adminChangeInvite,
  adminMintInvites,
  adminResetPassword,
  adminSetUserLocked,
  generateTemporaryPassword,
} from '@tm/db';
import { hashPassword } from 'better-auth/crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { asAdmin } from '@/lib/server/admin';
import { inviteKey } from '@/lib/server/invite-key';
import { logger } from '@/lib/server/log';

/**
 * The admin page's changes (ADR 0037). Each one checks the caller is an admin
 * here and again in the database, and the database audits it.
 */
export interface AdminActionState {
  status: 'idle' | 'done' | 'error';
  message?: string;
  /** Shown once: freshly minted invite codes or a temporary password. */
  secrets?: string[];
}

const uuid = z.string().uuid();

async function run(work: () => Promise<AdminActionState>, path: string): Promise<AdminActionState> {
  try {
    const result = await work();
    revalidatePath(path);
    return result;
  } catch (error) {
    if (error instanceof AdminError) return { status: 'error', message: error.message };
    // notFound() and redirect() throw on purpose; let Next handle them.
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    logger().error({ err: error }, 'Admin action failed');
    return { status: 'error', message: 'That did not work. Try again.' };
  }
}

export async function setUserLocked(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const userId = uuid.safeParse(form.get('userId'));
  const locked = form.get('locked') === 'true';
  if (!userId.success) return { status: 'error', message: 'Unknown person.' };
  return run(async () => {
    const changed = await asAdmin((tx) => adminSetUserLocked(tx, userId.data, locked));
    return {
      status: 'done',
      message: changed
        ? locked
          ? 'Locked. They were signed out everywhere and cannot sign in.'
          : 'Unlocked. They can sign in again.'
        : 'Nothing changed.',
    };
  }, '/admin/users');
}

export async function resetPassword(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const userId = uuid.safeParse(form.get('userId'));
  if (!userId.success) return { status: 'error', message: 'Unknown person.' };
  return run(async () => {
    const password = generateTemporaryPassword();
    const changed = await asAdmin(async (tx) =>
      adminResetPassword(tx, userId.data, await hashPassword(password)),
    );
    if (!changed) return { status: 'error', message: 'That account has no password to reset.' };
    return {
      status: 'done',
      message:
        'Temporary password set and they were signed out. Give it to them over a channel you trust; they change it in Settings › Security.',
      secrets: [password],
    };
  }, '/admin/users');
}

const mintSchema = z.object({
  count: z.coerce.number().int().min(1).max(50),
  note: z.string().trim().max(200).optional(),
  expiresInDays: z.coerce.number().int().min(0).max(365).optional(),
});

export async function mintInvites(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const parsed = mintSchema.safeParse({
    count: form.get('count'),
    note: form.get('note') || undefined,
    expiresInDays: form.get('expiresInDays') || undefined,
  });
  if (!parsed.success) {
    return { status: 'error', message: 'Choose between 1 and 50 codes, and up to 365 days.' };
  }
  const { count, note, expiresInDays } = parsed.data;
  return run(async () => {
    const codes = await asAdmin((tx) =>
      adminMintInvites(tx, count, {
        sealKey: inviteKey(),
        ...(note ? { note } : {}),
        ...(expiresInDays ? { expiresAt: new Date(Date.now() + expiresInDays * 86_400_000) } : {}),
      }),
    );
    return {
      status: 'done',
      message: `Minted ${codes.length} ${codes.length === 1 ? 'code' : 'codes'}. They are also listed below.`,
      secrets: codes,
    };
  }, '/admin/invites');
}

export async function changeInvite(
  _prev: AdminActionState,
  form: FormData,
): Promise<AdminActionState> {
  const inviteId = uuid.safeParse(form.get('inviteId'));
  const change = form.get('change');
  if (!inviteId.success || (change !== 'release' && change !== 'revoke')) {
    return { status: 'error', message: 'Unknown invite code.' };
  }
  return run(async () => {
    const changed = await asAdmin((tx) => adminChangeInvite(tx, inviteId.data, change));
    return {
      status: changed ? 'done' : 'error',
      message: changed
        ? change === 'release'
          ? 'Released: that code can be used again.'
          : 'Revoked: that code can no longer be used.'
        : 'Nothing changed: that code has already been used or changed.',
    };
  }, '/admin/invites');
}
