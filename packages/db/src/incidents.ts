import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Transaction } from './client';
import { notify, type NotificationKind } from './notifications';
import { OrderError } from './orders';
import type { INCIDENT_KINDS } from './schema';
import { executionIncidents, strategies, strategyRuntimes } from './schema';
import { strategyLabelSql } from './strategy-label';

/**
 * Execution incidents (Design v1.0 §8.5–8.6; ADR 0014): a reconciliation
 * mismatch, repeated rejections, stale or missing prices, or a lost broker
 * connection. Opening one can pause the runtimes it affects, because safety
 * is uncertain; each is shown until a person (or, for passing data problems,
 * the system) resolves it. Only one incident per kind and subject is open at a
 * time, so a problem that persists is not reported over and over.
 */

export type IncidentKind = (typeof INCIDENT_KINDS)[number];

const NOTIFICATION_FOR: Record<IncidentKind, NotificationKind> = {
  reconciliation_mismatch: 'reconciliation_mismatch',
  repeated_rejects: 'risk_pause',
  stale_data: 'stale_data',
  feed_loss: 'disconnect',
  broker_disconnected: 'disconnect',
  safety_close: 'triggered',
};

const TITLES: Record<IncidentKind, string> = {
  reconciliation_mismatch: 'Orders or positions do not match the broker',
  repeated_rejects: 'Paused after repeated rejected orders',
  stale_data: 'Prices are stale',
  feed_loss: 'Live prices are missing',
  broker_disconnected: 'The paper broker is not responding',
  safety_close: 'Safety close: positions were sold',
};

export interface OpenIncidentInput {
  userId: string;
  kind: IncidentKind;
  runtimeId?: string | undefined;
  accountId?: string | undefined;
  summary: string;
  details?: Record<string, unknown>;
  /** Running runtimes to pause because of it (§8.6). */
  pause?: string[] | undefined;
  /** Where the notification should lead. */
  link?: string | undefined;
}

/** Opens an incident unless the same one is already open. */
export async function openIncident(
  tx: Transaction,
  input: OpenIncidentInput,
): Promise<{ incidentId: string; created: boolean }> {
  const [row] = await tx
    .insert(executionIncidents)
    .values({
      userId: input.userId,
      kind: input.kind,
      runtimeId: input.runtimeId ?? null,
      accountId: input.accountId ?? null,
      summary: input.summary.slice(0, 500),
      details: input.details ?? {},
    })
    .onConflictDoNothing()
    .returning({ id: executionIncidents.id });
  if (!row) {
    const [existing] = await tx
      .select({ id: executionIncidents.id })
      .from(executionIncidents)
      .where(
        and(
          eq(executionIncidents.kind, input.kind),
          isNull(executionIncidents.resolvedAt),
          input.runtimeId
            ? eq(executionIncidents.runtimeId, input.runtimeId)
            : isNull(executionIncidents.runtimeId),
          input.accountId
            ? eq(executionIncidents.accountId, input.accountId)
            : isNull(executionIncidents.accountId),
        ),
      );
    if (!existing) return { incidentId: '', created: false };
    // Still unsafe: anything that started trading the same subject since is paused too.
    const more = await pauseForIncident(tx, input, existing.id);
    if (more.length > 0) {
      await tx
        .update(executionIncidents)
        .set({ pausedRuntimes: sql`${executionIncidents.pausedRuntimes} + ${more.length}` })
        .where(eq(executionIncidents.id, existing.id));
    }
    return { incidentId: existing.id, created: false };
  }

  const paused = await pauseForIncident(tx, input, row.id);
  if (paused.length > 0) {
    await tx
      .update(executionIncidents)
      .set({ pausedRuntimes: paused.length })
      .where(eq(executionIncidents.id, row.id));
  }
  await recordAudit(tx, {
    userId: input.userId,
    actorType: 'system',
    action: 'incident.opened',
    resourceType: 'execution_incident',
    resourceId: row.id,
    context: {
      kind: input.kind,
      runtimeId: input.runtimeId ?? null,
      accountId: input.accountId ?? null,
      pausedRuntimes: paused.map((p) => p.id),
    },
  });
  await notify(tx, {
    userId: input.userId,
    kind: NOTIFICATION_FOR[input.kind],
    title: TITLES[input.kind],
    body:
      paused.length > 0
        ? `${input.summary} Paused: ${paused.map((p) => p.name).join(', ')}.`
        : input.summary,
    link: input.link ?? '/orders',
    resourceType: 'execution_incident',
    resourceId: row.id,
    dedupeKey: `incident:${row.id}`,
  });
  return { incidentId: row.id, created: true };
}

async function pauseForIncident(tx: Transaction, input: OpenIncidentInput, incidentId: string) {
  if (!input.pause || input.pause.length === 0) return [];
  const rows = await tx
    .update(strategyRuntimes)
    .set({ status: 'paused', pauseReason: input.summary.slice(0, 500) })
    .where(and(inArray(strategyRuntimes.id, input.pause), eq(strategyRuntimes.status, 'running')))
    .returning({ id: strategyRuntimes.id, strategyId: strategyRuntimes.strategyId });
  if (rows.length === 0) return [];
  const names = new Map(
    (
      await tx
        .select({ id: strategies.id, name: strategyLabelSql })
        .from(strategies)
        .where(
          inArray(
            strategies.id,
            rows.map((r) => r.strategyId),
          ),
        )
    ).map((s) => [s.id, s.name ?? 'A strategy']),
  );
  const paused = rows.map((r) => ({ ...r, name: names.get(r.strategyId) ?? 'A strategy' }));
  for (const p of paused) {
    await recordAudit(tx, {
      userId: input.userId,
      actorType: 'system',
      action: 'runtime.auto_paused',
      resourceType: 'strategy_runtime',
      resourceId: p.id,
      context: { incidentId, kind: input.kind, reason: input.summary.slice(0, 500) },
    });
    if (NOTIFICATION_FOR[input.kind] !== 'risk_pause') {
      await notify(tx, {
        userId: input.userId,
        kind: 'risk_pause',
        title: `${p.name} paused`,
        body: input.summary,
        link: `/orders?strategy=${p.strategyId}`,
        resourceType: 'strategy_runtime',
        resourceId: p.id,
        dedupeKey: `pause:${incidentId}:${p.id}`,
      });
    }
  }
  return paused;
}

/** Closes an open incident. A person's resolution can carry a note. */
export async function resolveIncident(
  tx: Transaction,
  input: { userId: string; incidentId: string; by: 'user' | 'system'; note?: string | undefined },
): Promise<void> {
  const rows = await tx
    .update(executionIncidents)
    .set({
      resolvedAt: new Date(),
      resolvedBy: input.by,
      resolution: input.note ? input.note.slice(0, 500) : null,
    })
    .where(and(eq(executionIncidents.id, input.incidentId), isNull(executionIncidents.resolvedAt)))
    .returning({ id: executionIncidents.id, kind: executionIncidents.kind });
  const [row] = rows;
  if (!row) {
    if (input.by === 'system') return;
    throw new OrderError('not_found', 'This incident is not open');
  }
  await recordAudit(tx, {
    userId: input.userId,
    actorType: input.by,
    action: 'incident.resolved',
    resourceType: 'execution_incident',
    resourceId: row.id,
    context: { kind: row.kind, ...(input.note ? { note: input.note.slice(0, 500) } : {}) },
  });
}

/** Resolves the open incident of a kind for a runtime, once the condition has passed. */
export async function resolveIncidentsOf(
  tx: Transaction,
  userId: string,
  kind: IncidentKind,
  runtimeId: string,
  note: string,
): Promise<void> {
  const open = await tx
    .select({ id: executionIncidents.id })
    .from(executionIncidents)
    .where(
      and(
        eq(executionIncidents.kind, kind),
        eq(executionIncidents.runtimeId, runtimeId),
        isNull(executionIncidents.resolvedAt),
      ),
    );
  for (const i of open) {
    await resolveIncident(tx, { userId, incidentId: i.id, by: 'system', note });
  }
}

export interface IncidentRow {
  id: string;
  kind: IncidentKind;
  runtimeId: string | null;
  accountId: string | null;
  summary: string;
  details: unknown;
  pausedRuntimes: number;
  openedAt: string;
}

export async function listOpenIncidents(tx: Transaction): Promise<IncidentRow[]> {
  const rows = await tx
    .select()
    .from(executionIncidents)
    .where(isNull(executionIncidents.resolvedAt))
    .orderBy(desc(executionIncidents.openedAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as IncidentKind,
    runtimeId: r.runtimeId,
    accountId: r.accountId,
    summary: r.summary,
    details: r.details,
    pausedRuntimes: r.pausedRuntimes,
    openedAt: r.openedAt.toISOString(),
  }));
}

/** Whether an incident of this kind is open for the runtime. */
export async function hasOpenIncident(
  tx: Transaction,
  kind: IncidentKind,
  runtimeId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ n: sql<number>`1` })
    .from(executionIncidents)
    .where(
      and(
        eq(executionIncidents.kind, kind),
        eq(executionIncidents.runtimeId, runtimeId),
        isNull(executionIncidents.resolvedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Resolves an account's open incidents of a kind, once the condition has
 * passed: a reconciliation that comes back clean closes its mismatch (N301).
 * Returns how many were resolved.
 */
export async function resolveAccountIncidents(
  tx: Transaction,
  userId: string,
  kind: IncidentKind,
  accountId: string,
  note: string,
): Promise<number> {
  const open = await tx
    .select({ id: executionIncidents.id })
    .from(executionIncidents)
    .where(
      and(
        eq(executionIncidents.kind, kind),
        eq(executionIncidents.accountId, accountId),
        isNull(executionIncidents.resolvedAt),
      ),
    );
  for (const i of open) {
    await resolveIncident(tx, { userId, incidentId: i.id, by: 'system', note });
  }
  return open.length;
}

export interface SafetyCloseInput {
  userId: string;
  runtimeId: string;
  strategyId: string;
  /** The strategy as people see it, number first. */
  strategyName: string;
  /** Why, in words; the same text each closing order records. */
  reason: string;
  /** What was closed. */
  symbols: readonly string[];
  at: Date;
}

/**
 * Logs a safety close in the incident log, with its reason, and notifies
 * (N306, ADR 0105). It pauses nothing. A newer safety close for the same
 * strategy replaces one still open, so each stays listed with its own reason.
 */
export async function recordSafetyClose(tx: Transaction, input: SafetyCloseInput): Promise<string> {
  await resolveIncidentsOf(
    tx,
    input.userId,
    'safety_close',
    input.runtimeId,
    'A newer safety close replaced this one',
  );
  const list =
    input.symbols.length <= 8
      ? input.symbols.join(', ')
      : `${input.symbols.slice(0, 8).join(', ')} and ${input.symbols.length - 8} more`;
  const { incidentId } = await openIncident(tx, {
    userId: input.userId,
    kind: 'safety_close',
    runtimeId: input.runtimeId,
    summary: `${input.strategyName} sold ${list}. ${input.reason}`,
    details: { reason: input.reason, symbols: [...input.symbols], at: input.at.toISOString() },
    link: `/orders?strategy=${input.strategyId}`,
  });
  return incidentId;
}
