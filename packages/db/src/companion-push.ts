import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from './client';
import { sharedFeedOwner } from './feed-sharing';
import {
  agentConnections,
  companionPushes,
  instruments,
  mlModelRuns,
  mlModels,
  mlPredictions,
  researchCompanions,
} from './schema';

/**
 * The Local Companion's Frozen Output pushes (ADR 0117, S2 step 3a).
 *
 * The companion trains on its own computer against a local mirror of the
 * cloud's model registry, then pushes each new run (with its predictions),
 * evaluation and report. The web app only queues a push, as the person who
 * paired the companion; the worker applies it with its own login, after
 * checking the pairing still stands and is the producer's (O216). A run keeps
 * the id the companion gave it, so the evaluation it pushes later points at
 * the same run in the cloud. Applying is idempotent: a prediction date that
 * already has an active run is never rewritten.
 */

export const COMPANION_PUSH_KINDS = [
  'ml_run',
  'ml_evaluation',
  'ml_report',
  'pattern_scan_result',
  'pattern_decay',
] as const;
export type CompanionPushKind = (typeof COMPANION_PUSH_KINDS)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.uuid();

export const MlRunPush = z.object({
  run: z.object({
    id: uuid,
    modelKey: z.string().min(1).max(80),
    predictionDate: day,
    trainingStart: day,
    trainingEnd: day,
    maxLabelEnd: day,
    rowsTrained: z.number().int().min(0),
    crossSections: z.number().int().min(0),
    hyperparams: z.record(z.string(), z.unknown()),
    coefficients: z.record(z.string(), z.number().nullable()),
    codeVersion: z.string().min(1).max(120),
  }),
  /** [instrumentId, score] for each scored member. */
  predictions: z.array(z.tuple([uuid, z.number()])).max(5_000),
});
export type MlRunPush = z.infer<typeof MlRunPush>;

export const MlEvaluationPush = z.object({
  modelRunId: uuid,
  asOf: day,
  ic: z.number().nullable(),
  universeSize: z.number().int().min(0),
  predicted: z.number().int().min(0),
  labelled: z.number().int().min(0),
  decileSpread: z.number().nullable(),
});
export type MlEvaluationPush = z.infer<typeof MlEvaluationPush>;

export const MlReportPush = z.object({
  id: uuid,
  modelKey: z.string().min(1).max(80),
  markdown: z.string().max(1_000_000),
  summary: z.record(z.string(), z.unknown()),
  codeVersion: z.string().min(1).max(120),
});
export type MlReportPush = z.infer<typeof MlReportPush>;

/**
 * A pattern scan the companion ran (ADR 0120): the scan's outcome and its
 * finalists with their discovery and holdout occurrences, as the miner wrote
 * them into the companion's store.
 */
export const PatternScanResultPush = z.object({
  scan: z.object({
    id: uuid,
    status: z.enum(['done', 'failed']),
    error: z.string().max(500).nullable(),
    candidatesTested: z.number().int().min(0).nullable(),
    finalists: z.number().int().min(0).nullable(),
    verified: z.number().int().min(0).nullable(),
    effective: z.record(z.string(), z.unknown()).nullable(),
    codeVersion: z.string().max(120).nullable(),
    seconds: z.number().min(0).nullable(),
  }),
  patterns: z
    .array(
      z.object({
        id: uuid,
        rank: z.number().int().min(1),
        rule: z.array(z.unknown()),
        stats: z.record(z.string(), z.unknown()),
        status: z.enum(['candidate', 'verified']),
        /** [instrumentId, asOf, window, hit, maxRunup, maxDrawdown, forwardReturn] */
        occurrences: z
          .array(
            z.tuple([
              uuid,
              day,
              z.enum(['discovery', 'holdout']),
              z.boolean(),
              z.number(),
              z.number(),
              z.number(),
            ]),
          )
          .max(50_000),
      }),
    )
    .max(200),
  /**
   * One part of a scan too large for one push (N350): its patterns and occurrences go in, and
   * the scan stays as it is until the last part (no `partial`) sets its outcome.
   */
  partial: z.boolean().optional(),
});
export type PatternScanResultPush = z.infer<typeof PatternScanResultPush>;

/**
 * A Verified pattern re-scored on the companion (ADR 0121): its live
 * ("fresh") occurrences since the cloud's last score, and, on the last part,
 * its new decay state. A pattern with many new occurrences is sent in parts.
 */
export const PatternDecayPush = z.object({
  patternId: uuid,
  /** [instrumentId, asOf, hit, maxRunup, maxDrawdown, forwardReturn] */
  occurrences: z
    .array(z.tuple([uuid, day, z.boolean(), z.number(), z.number(), z.number()]))
    .max(20_000),
  /** Present on the last part only. */
  state: z
    .object({
      decayState: z.enum(['holding', 'weakening', 'broken']),
      decayStats: z.record(z.string(), z.unknown()),
      lastScored: day,
    })
    .optional(),
});
export type PatternDecayPush = z.infer<typeof PatternDecayPush>;

export const PUSH_SCHEMAS = {
  ml_run: MlRunPush,
  ml_evaluation: MlEvaluationPush,
  ml_report: MlReportPush,
  pattern_scan_result: PatternScanResultPush,
  pattern_decay: PatternDecayPush,
} as const;

export interface PushSummary {
  id: string;
  kind: string;
  clientKey: string;
  receivedAt: string;
  appliedAt: string | null;
  result: unknown;
  error: string | null;
}

/** Queues one push, once: a repeated client key returns the first push. */
export async function queueCompanionPush(
  tx: Transaction,
  who: { connectionId: string; userId: string },
  input: { kind: CompanionPushKind; clientKey: string; payload: unknown },
): Promise<{ id: string; duplicate: boolean }> {
  const [row] = await tx
    .insert(companionPushes)
    .values({
      connectionId: who.connectionId,
      userId: who.userId,
      kind: input.kind,
      clientKey: input.clientKey,
      payload: input.payload,
    })
    .onConflictDoNothing({ target: [companionPushes.connectionId, companionPushes.clientKey] })
    .returning({ id: companionPushes.id });
  if (row) return { id: row.id, duplicate: false };
  const [existing] = await tx
    .select({ id: companionPushes.id })
    .from(companionPushes)
    .where(
      and(
        eq(companionPushes.connectionId, who.connectionId),
        eq(companionPushes.clientKey, input.clientKey),
      ),
    );
  if (!existing) throw new Error('companion push vanished');
  return { id: existing.id, duplicate: true };
}

/** A companion's pushes, newest first, optionally only those received after `after`. */
export async function listCompanionPushes(
  tx: Transaction,
  connectionId: string,
  options: { limit?: number; pendingOrFailed?: boolean } = {},
): Promise<PushSummary[]> {
  const rows = await tx
    .select()
    .from(companionPushes)
    .where(
      and(
        eq(companionPushes.connectionId, connectionId),
        options.pendingOrFailed
          ? sql`(${companionPushes.appliedAt} is null or ${companionPushes.error} is not null)`
          : undefined,
      ),
    )
    .orderBy(desc(companionPushes.receivedAt))
    .limit(options.limit ?? 100);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    clientKey: r.clientKey,
    receivedAt: r.receivedAt.toISOString(),
    appliedAt: r.appliedAt?.toISOString() ?? null,
    result: r.result,
    error: r.error,
  }));
}

export interface CompanionMlModel {
  id: string;
  modelKey: string;
  name: string;
  universe: string;
  featureSet: unknown;
  featureSetVersion: number;
  label: unknown;
  algorithm: string;
  status: string;
  snapshotsFrom: string;
  availability: unknown;
}

export interface CompanionMlRun {
  id: string;
  modelId: string;
  runNo: number;
  predictionDate: string;
  trainingStart: string;
  trainingEnd: string;
  maxLabelEnd: string;
  rowsTrained: number;
  crossSections: number;
  hyperparams: unknown;
  coefficients: unknown;
  codeVersion: string;
  source: string;
  createdAt: string;
}

/** The model registry and every active run, for the companion's local mirror. */
export async function companionMlState(
  tx: Transaction,
): Promise<{ models: CompanionMlModel[]; runs: CompanionMlRun[] }> {
  const models = await tx
    .select({
      id: mlModels.id,
      modelKey: mlModels.modelKey,
      name: mlModels.name,
      universe: mlModels.universe,
      featureSet: mlModels.featureSet,
      featureSetVersion: mlModels.featureSetVersion,
      label: mlModels.label,
      algorithm: mlModels.algorithm,
      status: mlModels.status,
      snapshotsFrom: mlModels.snapshotsFrom,
      availability: mlModels.availability,
    })
    .from(mlModels)
    .orderBy(asc(mlModels.modelKey));
  const runs = await tx
    .select({
      id: mlModelRuns.id,
      modelId: mlModelRuns.modelId,
      runNo: mlModelRuns.runNo,
      predictionDate: mlModelRuns.predictionDate,
      trainingStart: mlModelRuns.trainingStart,
      trainingEnd: mlModelRuns.trainingEnd,
      maxLabelEnd: mlModelRuns.maxLabelEnd,
      rowsTrained: mlModelRuns.rowsTrained,
      crossSections: mlModelRuns.crossSections,
      hyperparams: mlModelRuns.hyperparams,
      coefficients: mlModelRuns.coefficients,
      codeVersion: mlModelRuns.codeVersion,
      source: mlModelRuns.source,
      createdAt: mlModelRuns.createdAt,
    })
    .from(mlModelRuns)
    .where(eq(mlModelRuns.status, 'active'))
    .orderBy(asc(mlModelRuns.modelId), asc(mlModelRuns.predictionDate));
  return { models, runs: runs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) };
}

/** One run's predictions, as [instrumentId, score]. */
export async function companionRunPredictions(
  tx: Transaction,
  runId: string,
): Promise<[string, number][]> {
  const rows = await tx
    .select({ instrumentId: mlPredictions.instrumentId, score: mlPredictions.score })
    .from(mlPredictions)
    .where(eq(mlPredictions.modelRunId, runId))
    .orderBy(asc(mlPredictions.instrumentId));
  return rows.map((r) => [r.instrumentId, Number(r.score)]);
}

// ---------------------------------------------------------------------------
// Applying (the worker, with its own login)

export class PushRefused extends Error {}

interface Pending {
  id: string;
  connectionId: string;
  userId: string;
  kind: string;
  payload: unknown;
}

async function companionLabel(tx: Transaction, connectionId: string): Promise<string> {
  const [row] = await tx
    .select({ version: researchCompanions.version, platform: researchCompanions.platform })
    .from(researchCompanions)
    .where(eq(researchCompanions.connectionId, connectionId));
  return row ? `Local companion ${row.version} (${row.platform})` : 'Local companion';
}

async function modelIdByKey(tx: Transaction, key: string): Promise<string> {
  const [model] = await tx
    .select({ id: mlModels.id, status: mlModels.status })
    .from(mlModels)
    .where(eq(mlModels.modelKey, key));
  if (!model) throw new PushRefused(`No model ${key}`);
  if (model.status !== 'registered') throw new PushRefused(`Model ${key} is retired`);
  return model.id;
}

async function applyRun(
  tx: Transaction,
  research: Database,
  push: Pending,
  payload: MlRunPush,
): Promise<Record<string, unknown>> {
  const { run, predictions } = payload;
  const modelId = await modelIdByKey(tx, run.modelKey);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ml_model_run:${modelId}`}))`);
  const [same] = await tx
    .select({ id: mlModelRuns.id, runNo: mlModelRuns.runNo })
    .from(mlModelRuns)
    .where(eq(mlModelRuns.id, run.id));
  if (same) return { runNo: same.runNo, skipped: 'already applied' };
  const [served] = await tx
    .select({ id: mlModelRuns.id, runNo: mlModelRuns.runNo })
    .from(mlModelRuns)
    .where(
      and(
        eq(mlModelRuns.modelId, modelId),
        eq(mlModelRuns.predictionDate, run.predictionDate),
        eq(mlModelRuns.status, 'active'),
      ),
    );
  if (served) return { skipped: 'date already served', servedBy: served.id, runNo: served.runNo };
  if (predictions.length > 0) {
    const ids = [...new Set(predictions.map(([iid]) => iid))];
    const known = await tx
      .select({ id: instruments.id })
      .from(instruments)
      .where(inArray(instruments.id, ids));
    if (known.length !== ids.length) throw new PushRefused('Predictions name unknown instruments');
  }
  const [next] = await tx
    .select({ n: sql<number>`coalesce(max(${mlModelRuns.runNo}), 0) + 1` })
    .from(mlModelRuns)
    .where(eq(mlModelRuns.modelId, modelId));
  const runNo = Number(next?.n ?? 1);
  // The date is frozen in the Research Store before its predictions exist (ADR 0115).
  await research.execute(
    sql`insert into ml_frozen_as_of (model_id, as_of) values (${modelId}, ${run.predictionDate}) on conflict do nothing`,
  );
  await tx.insert(mlModelRuns).values({
    id: run.id,
    modelId,
    runNo,
    predictionDate: run.predictionDate,
    trainingStart: run.trainingStart,
    trainingEnd: run.trainingEnd,
    maxLabelEnd: run.maxLabelEnd,
    rowsTrained: run.rowsTrained,
    crossSections: run.crossSections,
    hyperparams: run.hyperparams,
    coefficients: run.coefficients,
    codeVersion: run.codeVersion,
    source: 'companion',
    sourceDetail: await companionLabel(tx, push.connectionId),
  });
  for (let i = 0; i < predictions.length; i += 1000) {
    await tx.insert(mlPredictions).values(
      predictions.slice(i, i + 1000).map(([instrumentId, score]) => ({
        modelRunId: run.id,
        instrumentId,
        asOf: run.predictionDate,
        score,
      })),
    );
  }
  return { runNo, predictions: predictions.length };
}

async function applyEvaluation(
  tx: Transaction,
  research: Database,
  payload: MlEvaluationPush,
): Promise<Record<string, unknown>> {
  const [run] = await tx
    .select({ id: mlModelRuns.id, predictionDate: mlModelRuns.predictionDate })
    .from(mlModelRuns)
    .where(eq(mlModelRuns.id, payload.modelRunId));
  if (!run) throw new PushRefused('No such model run (push the run first)');
  if (run.predictionDate !== payload.asOf)
    throw new PushRefused('Evaluation date is not the run date');
  const rows = await research.execute(sql`
    insert into ml_evaluation (model_run_id, as_of, ic, universe_size, predicted, labelled, decile_spread)
    values (${payload.modelRunId}, ${payload.asOf}, ${payload.ic}, ${payload.universeSize},
            ${payload.predicted}, ${payload.labelled}, ${payload.decileSpread})
    on conflict do nothing
    returning model_run_id`);
  return rows.length > 0 ? { evaluated: payload.asOf } : { skipped: 'already evaluated' };
}

async function applyReport(
  tx: Transaction,
  research: Database,
  payload: MlReportPush,
): Promise<Record<string, unknown>> {
  const modelId = await modelIdByKey(tx, payload.modelKey);
  const rows = await research.execute(sql`
    insert into ml_report (id, model_id, markdown, summary, code_version)
    values (${payload.id}, ${modelId}, ${payload.markdown}, ${JSON.stringify(payload.summary)}::jsonb,
            ${payload.codeVersion})
    on conflict do nothing
    returning id`);
  return rows.length > 0 ? { report: payload.id } : { skipped: 'already applied' };
}

/**
 * Writes a scan the companion ran into the cloud's Research Store, once: only
 * a scan the companion claimed (still `running`) takes a result, so a repeat,
 * or a scan the cloud's own miner finished, is skipped.
 */
async function applyPatternScan(
  research: Database,
  payload: PatternScanResultPush,
): Promise<Record<string, unknown>> {
  const { scan, patterns, partial } = payload;
  return research.transaction(async (rtx) => {
    const [row] = await rtx.execute<{ user_id: string; status: string }>(sql`
      select user_id::text, status from pattern_scan where id = ${scan.id} for update`);
    if (!row) throw new PushRefused('No such pattern scan');
    // A scan released back to the queue while its companion was away (ADR 0121) still takes the result.
    if (row.status !== 'running' && row.status !== 'queued')
      return { skipped: `scan already ${row.status}` };
    for (const p of patterns) {
      await rtx.execute(sql`
        insert into pattern (id, scan_id, user_id, rank, rule, stats, status)
        values (${p.id}, ${scan.id}, ${row.user_id}, ${p.rank}, ${JSON.stringify(p.rule)}::jsonb,
                ${JSON.stringify(p.stats)}::jsonb, ${p.status})
        on conflict (id) do nothing`);
      for (let i = 0; i < p.occurrences.length; i += 1000) {
        const chunk = p.occurrences.slice(i, i + 1000);
        await rtx.execute(sql`
          insert into pattern_occurrence (pattern_id, user_id, instrument_id, as_of, "window", hit,
                                          max_runup, max_drawdown, forward_return)
          select ${p.id}::uuid, ${row.user_id}::uuid, o.instrument_id, o.as_of, o.window, o.hit,
                 o.max_runup, o.max_drawdown, o.forward_return
          from jsonb_to_recordset(${JSON.stringify(
            chunk.map(([instrumentId, asOf, window, hit, runup, drawdown, forward]) => ({
              instrument_id: instrumentId,
              as_of: asOf,
              window,
              hit,
              max_runup: runup,
              max_drawdown: drawdown,
              forward_return: forward,
            })),
          )}::jsonb) as o(instrument_id uuid, as_of date, "window" text, hit boolean,
                          max_runup double precision, max_drawdown double precision,
                          forward_return double precision)
          on conflict do nothing`);
      }
    }
    if (partial) return { scan: scan.id, part: true, patterns: patterns.length };
    await rtx.execute(sql`
      update pattern_scan set status = ${scan.status}, error = ${scan.error},
        candidates_tested = ${scan.candidatesTested}, finalists = ${scan.finalists},
        verified = ${scan.verified},
        effective = ${scan.effective === null ? null : JSON.stringify(scan.effective)}::jsonb,
        code_version = ${scan.codeVersion}, seconds = ${scan.seconds}, finished_at = now()
      where id = ${scan.id}`);
    return { scan: scan.id, status: scan.status, patterns: patterns.length };
  });
}

async function applyPatternDecay(
  research: Database,
  payload: PatternDecayPush,
): Promise<Record<string, unknown>> {
  const { patternId, occurrences, state } = payload;
  return research.transaction(async (rtx) => {
    const [row] = await rtx.execute<{
      user_id: string;
      status: string;
      last_scored: string | null;
      decay_stats: Record<string, unknown> | null;
    }>(sql`
      select user_id::text, status, last_scored::text, decay_stats
      from pattern where id = ${patternId} for update`);
    if (!row) throw new PushRefused('No such pattern');
    if (row.status !== 'verified') return { skipped: 'pattern is not verified' };
    if (occurrences.length > 0) {
      await rtx.execute(sql`
        insert into pattern_occurrence (pattern_id, user_id, instrument_id, as_of, "window", hit,
                                        max_runup, max_drawdown, forward_return)
        select ${patternId}::uuid, ${row.user_id}::uuid, o.instrument_id, o.as_of, 'fresh', o.hit,
               o.max_runup, o.max_drawdown, o.forward_return
        from jsonb_to_recordset(${JSON.stringify(
          occurrences.map(([instrumentId, asOf, hit, runup, drawdown, forward]) => ({
            instrument_id: instrumentId,
            as_of: asOf,
            hit,
            max_runup: runup,
            max_drawdown: drawdown,
            forward_return: forward,
          })),
        )}::jsonb) as o(instrument_id uuid, as_of date, hit boolean, max_runup double precision,
                        max_drawdown double precision, forward_return double precision)
        on conflict do nothing`);
    }
    if (!state) return { pattern: patternId, occurrences: occurrences.length };
    // An older score never replaces a newer one.
    if (row.last_scored !== null && row.last_scored > state.lastScored)
      return { pattern: patternId, occurrences: occurrences.length, skipped: 'scored since' };
    // A re-verify asked for in the cloud after the companion read the pattern stays asked for.
    const stats: Record<string, unknown> = { ...state.decayStats };
    const asked = row.decay_stats?.reverifyRequestedAt;
    const answered = (stats.reverify as { requestedAt?: unknown } | undefined)?.requestedAt;
    if (asked !== undefined && asked !== answered) stats.reverifyRequestedAt = asked;
    else delete stats.reverifyRequestedAt;
    await rtx.execute(sql`
      update pattern set decay_state = ${state.decayState}, decay_stats = ${JSON.stringify(stats)}::jsonb,
        last_scored = ${state.lastScored}
      where id = ${patternId}`);
    return {
      pattern: patternId,
      occurrences: occurrences.length,
      state: state.decayState,
      lastScored: state.lastScored,
    };
  });
}

/**
 * Applies waiting pushes, oldest first, each in its own Core transaction.
 * Returns what happened to each. A refused push records why and is not
 * retried; an unexpected error is left for the next pass.
 */
export async function applyCompanionPushes(options: {
  core: Database;
  research: Database;
  limit?: number;
}): Promise<{ id: string; kind: string; result?: unknown; error?: string }[]> {
  const out: { id: string; kind: string; result?: unknown; error?: string }[] = [];
  for (let i = 0; i < (options.limit ?? 50); i += 1) {
    const done = await options.core.transaction(async (tx) => {
      const [push] = await tx
        .select({
          id: companionPushes.id,
          connectionId: companionPushes.connectionId,
          userId: companionPushes.userId,
          kind: companionPushes.kind,
          payload: companionPushes.payload,
        })
        .from(companionPushes)
        .where(and(isNull(companionPushes.appliedAt), isNull(companionPushes.error)))
        .orderBy(asc(companionPushes.receivedAt), asc(companionPushes.id))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!push) return null;
      const finish = async (result: Record<string, unknown> | null, error: string | null) => {
        await tx
          .update(companionPushes)
          .set({ appliedAt: error ? null : sql`now()`, result, error })
          .where(eq(companionPushes.id, push.id));
        return { id: push.id, kind: push.kind, ...(error ? { error } : { result }) };
      };
      try {
        // A savepoint, so a refused push is recorded while its writes are undone.
        const result = await tx.transaction(async (sp) => {
          const producer = await sharedFeedOwner(sp);
          if (producer !== push.userId) {
            throw new PushRefused(
              'Only the research producer’s companion may publish shared research',
            );
          }
          // The pairing is read as its owner (row-level security).
          await sp.execute(sql`select set_config('app.user_id', ${push.userId}, true)`);
          const [conn] = await sp
            .select({ scope: agentConnections.scope, revokedAt: agentConnections.revokedAt })
            .from(agentConnections)
            .where(eq(agentConnections.id, push.connectionId));
          if (!conn || conn.scope !== 'research_sync' || conn.revokedAt) {
            throw new PushRefused('The companion was unpaired before this push was applied');
          }
          let applied: Record<string, unknown>;
          if (push.kind === 'ml_run') {
            applied = await applyRun(sp, options.research, push, MlRunPush.parse(push.payload));
          } else if (push.kind === 'ml_evaluation') {
            applied = await applyEvaluation(
              sp,
              options.research,
              MlEvaluationPush.parse(push.payload),
            );
          } else if (push.kind === 'ml_report') {
            applied = await applyReport(sp, options.research, MlReportPush.parse(push.payload));
          } else if (push.kind === 'pattern_scan_result') {
            applied = await applyPatternScan(
              options.research,
              PatternScanResultPush.parse(push.payload),
            );
          } else if (push.kind === 'pattern_decay') {
            applied = await applyPatternDecay(
              options.research,
              PatternDecayPush.parse(push.payload),
            );
          } else {
            throw new PushRefused(`Unknown push kind ${push.kind}`);
          }
          await sp
            .update(researchCompanions)
            .set({ lastPushAt: sql`now()`, lastPushKind: push.kind })
            .where(eq(researchCompanions.connectionId, push.connectionId));
          await sp.execute(sql`select set_config('app.user_id', '', true)`);
          return applied;
        });
        return finish(result, null);
      } catch (error) {
        await tx.execute(sql`select set_config('app.user_id', '', true)`);
        if (error instanceof PushRefused || error instanceof z.ZodError) {
          return finish(
            null,
            error instanceof z.ZodError ? 'The push is malformed' : error.message,
          );
        }
        // A database rule refused the data itself (the embargo check, a bad value): final.
        const code =
          (error as { code?: unknown }).code ??
          (error as { cause?: { code?: unknown } }).cause?.code;
        if (typeof code === 'string' && (code.startsWith('22') || code.startsWith('23'))) {
          const message = error instanceof Error ? error.message : String(error);
          return finish(null, `Refused by the database: ${message.slice(0, 300)}`);
        }
        throw error;
      }
    });
    if (!done) break;
    out.push(done);
  }
  return out;
}

/** How many pushes wait to be applied (optionally only those received after `since`). */
export async function pendingPushCount(db: Database | Transaction, since?: Date) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(companionPushes)
    .where(
      and(
        isNull(companionPushes.appliedAt),
        isNull(companionPushes.error),
        since ? gt(companionPushes.receivedAt, since) : undefined,
      ),
    );
  return row?.n ?? 0;
}
