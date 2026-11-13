import { randomInt } from 'node:crypto';
import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { Transaction } from './client';
import { screenSnapshots } from './schema';

/**
 * Screen snapshots (N272, ADR 0093): what the Ask AI panel saw on a screen,
 * saved so an agent can read it through get_screen_context from a short code
 * in the prompt. Row-level security keeps each person's snapshots their own.
 */

/** How long a snapshot stays readable. */
export const SCREEN_SNAPSHOT_HOURS = 24;

/** Letters and digits that are hard to misread (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newSnapshotCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export interface ScreenSnapshot {
  code: string;
  question: string;
  content: unknown;
  createdAt: string;
  expiresAt: string;
}

const toSnapshot = (r: typeof screenSnapshots.$inferSelect): ScreenSnapshot => ({
  code: r.code,
  question: r.question,
  content: r.content,
  createdAt: r.createdAt.toISOString(),
  expiresAt: r.expiresAt.toISOString(),
});

/** Saves a snapshot and clears the person's expired ones. */
export async function saveScreenSnapshot(
  tx: Transaction,
  userId: string,
  input: { question: string; content: unknown },
  now = new Date(),
): Promise<ScreenSnapshot> {
  await tx
    .delete(screenSnapshots)
    .where(and(eq(screenSnapshots.userId, userId), lte(screenSnapshots.expiresAt, now)));
  const [row] = await tx
    .insert(screenSnapshots)
    .values({
      userId,
      code: newSnapshotCode(),
      question: input.question,
      content: input.content,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SCREEN_SNAPSHOT_HOURS * 3_600_000),
    })
    .returning();
  if (!row) throw new Error('screen snapshot was not saved');
  return toSnapshot(row);
}

/**
 * The person's snapshot with `code`, or their newest one when `code` is
 * omitted; null when there is none or it has expired.
 */
export async function getScreenSnapshot(
  tx: Transaction,
  userId: string,
  code?: string,
  now = new Date(),
): Promise<ScreenSnapshot | null> {
  const live = and(eq(screenSnapshots.userId, userId), gt(screenSnapshots.expiresAt, now));
  const [row] = await tx
    .select()
    .from(screenSnapshots)
    .where(code ? and(eq(screenSnapshots.code, code.trim().toUpperCase()), live) : live)
    .orderBy(desc(screenSnapshots.createdAt))
    .limit(1);
  return row ? toSnapshot(row) : null;
}
