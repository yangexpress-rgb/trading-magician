import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import {
  createTokenConnection,
  revokeAgentConnection,
  type AgentConnectionSummary,
} from './agents';
import type { Database, Transaction } from './client';
import { agentConnections, groupMembershipPeriod, instruments, researchCompanions } from './schema';

/**
 * The Local Companion's pairing and status (storage separation S2, ADR 0116).
 * A companion pairs to one person's account with an agent connection of scope
 * `research_sync`: the same tokens, hashing, revoking and audit as AI agents,
 * but the token reaches only the companion API. The cloud never waits on a
 * companion; it only reads when one was last seen.
 */

/** The agent profile id a companion pairing is made under. */
export const COMPANION_PROFILE_ID = 'local-companion';
export const COMPANION_CONNECTION_NAME = 'Local research companion';
/** A companion not seen for this long counts as offline (A4's 48 hours). */
export const COMPANION_OFFLINE_AFTER_MS = 48 * 3_600_000;

/** What research pages say while research runs locally and no companion is connected. */
export const RESEARCH_COMPANION_PAUSED =
  "Local research storage isn't connected — ML training and pattern mining are paused. Trading is unaffected.";

/** Where research jobs run: in the cloud (S1) or on a paired companion (S2). */
export type ResearchMode = 'cloud' | 'companion';

export type ResearchStorageStatus =
  { mode: 'cloud' } | { mode: 'companion'; connected: boolean; seenAt: string | null };

export interface CompanionSummary {
  connection: AgentConnectionSummary;
  version: string | null;
  platform: string | null;
  seenAt: string | null;
  lastPushAt: string | null;
  lastPushKind: string | null;
}

/** Pairs a new companion: the token is returned here, once, and never again. */
export async function pairCompanion(
  tx: Transaction,
  userId: string,
  now = new Date(),
): Promise<{ connection: AgentConnectionSummary; token: string }> {
  return createTokenConnection(
    tx,
    userId,
    {
      profileId: COMPANION_PROFILE_ID,
      name: COMPANION_CONNECTION_NAME,
      scope: 'research_sync',
      expiry: 'none',
    },
    now,
  );
}

/** Unpairs a companion: its token stops working at once. */
export async function unpairCompanion(
  tx: Transaction,
  userId: string,
  connectionId: string,
): Promise<AgentConnectionSummary> {
  const [row] = await tx
    .select({ scope: agentConnections.scope })
    .from(agentConnections)
    .where(eq(agentConnections.id, connectionId));
  if (row?.scope !== 'research_sync') throw new Error('Not a companion pairing');
  return revokeAgentConnection(tx, userId, connectionId);
}

/** The person's companion pairings, newest first, with what each last reported. */
export async function listCompanions(tx: Transaction): Promise<CompanionSummary[]> {
  const rows = await tx
    .select({ c: agentConnections, r: researchCompanions })
    .from(agentConnections)
    .leftJoin(researchCompanions, eq(researchCompanions.connectionId, agentConnections.id))
    .where(eq(agentConnections.scope, 'research_sync'))
    .orderBy(desc(agentConnections.createdAt), desc(agentConnections.id));
  const now = new Date();
  return rows.map(({ c, r }) => ({
    connection: {
      id: c.id,
      profileId: c.profileId,
      name: c.name,
      authMethod: c.authMethod,
      scope: c.scope,
      tokenHint: c.tokenHint,
      createdAt: c.createdAt.toISOString(),
      expiresAt: c.expiresAt?.toISOString() ?? null,
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
      revokedAt: c.revokedAt?.toISOString() ?? null,
      status: c.revokedAt ? 'revoked' : c.expiresAt && c.expiresAt <= now ? 'expired' : 'active',
    },
    version: r?.version ?? null,
    platform: r?.platform ?? null,
    seenAt: r?.seenAt.toISOString() ?? null,
    lastPushAt: r?.lastPushAt?.toISOString() ?? null,
    lastPushKind: r?.lastPushKind ?? null,
  }));
}

const clip = (s: string) => s.trim().slice(0, 40) || 'unknown';

/** A companion's hello: records its version and platform and that it was seen now. */
export async function companionHello(
  tx: Transaction,
  who: { connectionId: string; userId: string },
  input: { version: string; platform: string },
): Promise<{ seenAt: string }> {
  const [row] = await tx
    .insert(researchCompanions)
    .values({
      connectionId: who.connectionId,
      userId: who.userId,
      version: clip(input.version),
      platform: clip(input.platform),
      seenAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: researchCompanions.connectionId,
      set: {
        version: clip(input.version),
        platform: clip(input.platform),
        seenAt: sql`now()`,
      },
    })
    .returning({ seenAt: researchCompanions.seenAt });
  if (!row) throw new Error('companion hello failed');
  return { seenAt: row.seenAt.toISOString() };
}

/** Records that a companion delivered a Frozen Output (`kind` names what). */
export async function recordCompanionPush(
  tx: Transaction,
  connectionId: string,
  kind: string,
): Promise<void> {
  await tx
    .update(researchCompanions)
    .set({ lastPushAt: sql`now()`, lastPushKind: kind.slice(0, 40), seenAt: sql`now()` })
    .where(eq(researchCompanions.connectionId, connectionId));
}

/**
 * Whether research storage is connected. In cloud mode research runs in the
 * cloud and is always available. In companion mode it is connected while the
 * producer's companion (the platform admin's, by default) was seen within 48
 * hours. Any member may ask: only one timestamp is read.
 */
export async function researchStorageStatus(
  db: Database | Transaction,
  options: { mode: ResearchMode; producerUserId: string | null; now?: Date },
): Promise<ResearchStorageStatus> {
  if (options.mode === 'cloud') return { mode: 'cloud' };
  if (!options.producerUserId) return { mode: 'companion', connected: false, seenAt: null };
  const rows = await db.execute<{ seen_at: Date | string | null }>(
    sql`select research_companion_seen_at(${options.producerUserId}::uuid) as seen_at`,
  );
  const raw = rows[0]?.seen_at ?? null;
  const seenAt = raw === null ? null : new Date(raw);
  const now = options.now ?? new Date();
  return {
    mode: 'companion',
    connected: seenAt !== null && now.getTime() - seenAt.getTime() < COMPANION_OFFLINE_AFTER_MS,
    seenAt: seenAt?.toISOString() ?? null,
  };
}

/** One page of instruments for a companion (read-only reference data), in id order. */
export async function companionInstruments(
  tx: Transaction,
  options: { after?: string | undefined; limit: number },
): Promise<
  {
    id: string;
    symbol: string;
    assetClass: string;
    kind: string;
    displayName: string;
    venue: string;
    currency: string;
  }[]
> {
  const rows = await tx
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
      kind: instruments.kind,
      displayName: instruments.displayName,
      venue: instruments.venue,
      currency: instruments.currency,
    })
    .from(instruments)
    .where(
      and(
        eq(instruments.isDemo, false),
        options.after ? gt(instruments.id, options.after) : undefined,
      ),
    )
    .orderBy(asc(instruments.id))
    .limit(options.limit);
  return rows;
}

/** Point-in-time group membership (ADR 0112), every period, for a companion. */
export async function companionMembership(tx: Transaction): Promise<
  {
    groupId: string;
    symbol: string;
    instrumentId: string | null;
    fromDate: string;
    toDate: string | null;
  }[]
> {
  return tx
    .select({
      groupId: groupMembershipPeriod.groupId,
      symbol: groupMembershipPeriod.symbol,
      instrumentId: groupMembershipPeriod.instrumentId,
      fromDate: groupMembershipPeriod.fromDate,
      toDate: groupMembershipPeriod.toDate,
    })
    .from(groupMembershipPeriod)
    .orderBy(
      asc(groupMembershipPeriod.groupId),
      asc(groupMembershipPeriod.symbol),
      asc(groupMembershipPeriod.fromDate),
    );
}
