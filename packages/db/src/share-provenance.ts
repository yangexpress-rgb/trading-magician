import { eq } from 'drizzle-orm';
import type { Transaction } from './client';
import { strategyShares } from './schema';

/**
 * "Shared by Yong (U0001)" on a received copy (ADR 0056). Read through row-level
 * security, so only the share's sender and recipient get it; anyone else gets
 * null (the Library shows them only the copied-from number).
 */
export interface SharedProvenance {
  shareId: string;
  /** Null once the sender's account is purged ("a former member"). */
  senderName: string | null;
  senderCode: string;
  senderIsAdmin: boolean;
  /** The number the copy was made from. */
  sourceNumber: string;
  /** When the copy was made. */
  acceptedAt: Date | null;
}

export async function sharedProvenance(
  tx: Transaction,
  shareId: string | null,
): Promise<SharedProvenance | null> {
  if (!shareId) return null;
  const [row] = await tx
    .select({
      shareId: strategyShares.id,
      senderName: strategyShares.senderName,
      senderCode: strategyShares.senderCode,
      senderIsAdmin: strategyShares.senderIsAdmin,
      sourceNumber: strategyShares.sourceNumber,
      acceptedAt: strategyShares.decidedAt,
    })
    .from(strategyShares)
    .where(eq(strategyShares.id, shareId));
  return row ?? null;
}

/** "Yong (U0001)", or "a former member (U0001)". */
export function sharePersonLabel(name: string | null, code: string): string {
  return `${name ?? 'a former member'} (${code})`;
}
