'use server';

import {
  addWatchGroup,
  addWatchItem,
  deleteWatchGroup,
  moveWatchGroup,
  moveWatchItem,
  removeWatchItem,
  renameWatchGroup,
  setWatchGroupCollapsed,
  WatchListError,
  withTenant,
  type Transaction,
} from '@tm/db';
import { z } from 'zod';
import { appDb } from '@/lib/server/db';
import { logger } from '@/lib/server/log';
import { requireTenant } from '@/lib/server/session';

/** Watch list changes (N292, ADR 0101); the page reloads the list after each. */
export interface WatchActionResult {
  ok: boolean;
  message?: string;
}

const uuid = z.string().uuid();

async function run(
  what: string,
  fn: (tx: Transaction, userId: string) => Promise<unknown>,
): Promise<WatchActionResult> {
  const tenant = await requireTenant();
  try {
    await withTenant(appDb(), tenant, (tx) => fn(tx, tenant.userId));
    return { ok: true };
  } catch (error) {
    if (error instanceof WatchListError) return { ok: false, message: error.message };
    logger().warn({ err: { name: (error as Error).name } }, `watch list: ${what} failed`);
    return { ok: false, message: 'That did not save. Try again.' };
  }
}

export async function addWatchSymbol(input: {
  groupId: string;
  symbol: string;
  instrumentId?: string | null;
  displayName?: string | null;
}): Promise<WatchActionResult> {
  const parsed = z
    .object({
      groupId: uuid,
      symbol: z.string().max(20),
      instrumentId: uuid.nullish(),
      displayName: z.string().max(200).nullish(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That symbol could not be added.' };
  return run('add symbol', (tx, userId) => addWatchItem(tx, userId, parsed.data));
}

export async function removeWatchSymbol(itemId: string): Promise<WatchActionResult> {
  if (!uuid.safeParse(itemId).success) return { ok: false };
  return run('remove symbol', (tx) => removeWatchItem(tx, itemId));
}

export async function moveWatchSymbol(itemId: string, by: -1 | 1): Promise<WatchActionResult> {
  if (!uuid.safeParse(itemId).success || (by !== -1 && by !== 1)) return { ok: false };
  return run('move symbol', (tx) => moveWatchItem(tx, itemId, by));
}

export async function createWatchGroup(name: string): Promise<WatchActionResult> {
  return run('add group', (tx, userId) => addWatchGroup(tx, userId, String(name)));
}

export async function renameWatchListGroup(
  groupId: string,
  name: string,
): Promise<WatchActionResult> {
  if (!uuid.safeParse(groupId).success) return { ok: false };
  return run('rename group', (tx) => renameWatchGroup(tx, groupId, String(name)));
}

export async function foldWatchGroup(
  groupId: string,
  collapsed: boolean,
): Promise<WatchActionResult> {
  if (!uuid.safeParse(groupId).success) return { ok: false };
  return run('fold group', (tx) => setWatchGroupCollapsed(tx, groupId, collapsed === true));
}

export async function moveWatchListGroup(groupId: string, by: -1 | 1): Promise<WatchActionResult> {
  if (!uuid.safeParse(groupId).success || (by !== -1 && by !== 1)) return { ok: false };
  return run('move group', (tx) => moveWatchGroup(tx, groupId, by));
}

export async function deleteWatchListGroup(groupId: string): Promise<WatchActionResult> {
  if (!uuid.safeParse(groupId).success) return { ok: false };
  return run('delete group', (tx) => deleteWatchGroup(tx, groupId));
}
