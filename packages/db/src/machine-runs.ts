import { and, asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import { strategyRuntimes, strategyTransitions } from './schema';
import type { MachineRunState } from './runtime';

/**
 * State-machine runs (state-machine brief v1.4 §2.4, §2.6, §2.9; ADR 0124
 * P3a): their transition records and the Start confirmation.
 */

export type TransitionOutcome =
  'switched_no_orders' | 'rebalancing' | 'done' | 'incomplete' | 'stuck' | 'superseded';

export interface TransitionInput {
  userId: string;
  runtimeId: string;
  seq: number;
  kind: 'start' | 'switch';
  cycleId?: string | undefined;
  decidedOn: string;
  fromStateId: string | null;
  toStateId: string;
  rowId: string | null;
  why: unknown[];
  outcome: TransitionOutcome;
  completedOn?: string | undefined;
}

export async function insertTransition(tx: Transaction, t: TransitionInput): Promise<string> {
  const [row] = await tx
    .insert(strategyTransitions)
    .values({
      userId: t.userId,
      runtimeId: t.runtimeId,
      seq: t.seq,
      kind: t.kind,
      cycleId: t.cycleId ?? null,
      decidedOn: t.decidedOn,
      fromStateId: t.fromStateId,
      toStateId: t.toStateId,
      rowId: t.rowId,
      why: t.why,
      outcome: t.outcome,
      completedOn: t.completedOn ?? null,
      rounds: t.cycleId ? 1 : 0,
    })
    .returning({ id: strategyTransitions.id });
  if (!row) throw new Error('Failed to record the transition');
  return row.id;
}

export async function updateTransition(
  tx: Transaction,
  id: string,
  values: { outcome?: TransitionOutcome; rounds?: number; completedOn?: string },
): Promise<void> {
  await tx.update(strategyTransitions).set(values).where(eq(strategyTransitions.id, id));
}

export interface TransitionRecord {
  id: string;
  seq: number;
  kind: 'start' | 'switch';
  cycleId: string | null;
  decidedOn: string;
  fromStateId: string | null;
  toStateId: string;
  rowId: string | null;
  why: unknown[];
  outcome: TransitionOutcome;
  rounds: number;
  completedOn: string | null;
}

/** A run's transitions, oldest first (§2.6). */
export async function listTransitions(
  tx: Transaction,
  runtimeId: string,
): Promise<TransitionRecord[]> {
  const rows = await tx
    .select()
    .from(strategyTransitions)
    .where(eq(strategyTransitions.runtimeId, runtimeId))
    .orderBy(asc(strategyTransitions.seq));
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    kind: r.kind as TransitionRecord['kind'],
    cycleId: r.cycleId,
    decidedOn: r.decidedOn,
    fromStateId: r.fromStateId,
    toStateId: r.toStateId,
    rowId: r.rowId,
    why: r.why as unknown[],
    outcome: r.outcome as TransitionOutcome,
    rounds: r.rounds,
    completedOn: r.completedOn,
  }));
}

export class MachineStartError extends Error {
  constructor(
    public readonly code: 'not_found' | 'not_ready' | 'already_confirmed',
    message: string,
  ) {
    super(message);
    this.name = 'MachineStartError';
  }
}

/**
 * The person confirms Start after seeing the replay (§2.9): the run adopts
 * the replayed state, and its next pass places the Start rebalance. Refused
 * until the replay has a proposal, and once confirmed.
 */
export async function confirmMachineStart(
  tx: Transaction,
  runtimeId: string,
  now = new Date(),
  /** When given, the run must belong to this strategy. */
  strategyId?: string,
): Promise<MachineRunState> {
  const [row] = await tx
    .select({
      state: strategyRuntimes.state,
      status: strategyRuntimes.status,
      strategyId: strategyRuntimes.strategyId,
    })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, runtimeId))
    .for('update');
  if (!row || row.status === 'stopped' || (strategyId && row.strategyId !== strategyId))
    throw new MachineStartError('not_found', 'Run not found');
  const machine = (row.state as { machine?: MachineRunState }).machine;
  if (!machine?.proposal)
    throw new MachineStartError(
      'not_ready',
      'The replay has not finished yet. Try again in a minute.',
    );
  if (machine.confirmedAt)
    throw new MachineStartError('already_confirmed', 'Start was already confirmed');
  await tx
    .update(strategyRuntimes)
    .set({
      state: sql`jsonb_set(${strategyRuntimes.state}, '{machine,confirmedAt}', to_jsonb(${now.getTime()}::bigint))`,
    })
    .where(and(eq(strategyRuntimes.id, runtimeId)));
  return { ...machine, confirmedAt: now.getTime() };
}

/** A run's machine state, for the run view (§5). */
export async function machineRunState(
  tx: Transaction,
  runtimeId: string,
): Promise<MachineRunState | undefined> {
  const [row] = await tx
    .select({ state: strategyRuntimes.state })
    .from(strategyRuntimes)
    .where(eq(strategyRuntimes.id, runtimeId));
  return (row?.state as { machine?: MachineRunState } | undefined)?.machine;
}
