import {
  libraryV2Fields,
  LIBRARY_V2_FIELD_NAMES,
  type LibraryMaturity,
  type LibraryV2Fields,
} from '@tm/domain';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import {
  DEFAULT_SOURCES,
  LIBRARY_V2_BACKFILL,
  type BackfillField,
} from './library-backfill-v2-data';
import { STRATEGY_LIBRARY_SEED, type SeedEntry } from './library-seed';
import {
  backtestRuns,
  strategyLibraryEntries as entries,
  strategyLibraryRevisions as revisions,
} from './schema';

/**
 * The Library v2 field backfill (ADR 0055, brief §2.3). Fills the nine fields
 * of the seed entries from LIBRARY_V2_BACKFILL (seed prose and the brief's
 * worked examples) and derives maturity from the database: Back tested when
 * the entry's linked Lab strategy has at least one completed back-test run,
 * otherwise Researched. Paper trading and Live are only ever set by hand.
 *
 * It never overwrites what a person wrote: a field that already holds a
 * different, non-empty value is kept and reported. Re-running changes
 * nothing. Owner connection only (it reads back-test runs of every workspace).
 */

export const BACKFILL_NOTE = 'Backfilled Library v2 fields';

export type FieldAction = 'set' | 'same' | 'kept';

export interface BackfillFieldPlan {
  field: (typeof LIBRARY_V2_FIELD_NAMES)[number];
  action: FieldAction;
  /** The value the backfill would write (or, when kept, the value it would have written). */
  value: unknown;
  /** What is stored now. */
  current: unknown;
  source: string;
  /** True when the value is "not specified" (null, empty, or an `unspecified` choice). */
  unspecified: boolean;
}

export interface BackfillEntryPlan {
  entryId: string;
  registrationNumber: string;
  name: string;
  seedKey: string;
  fields: BackfillFieldPlan[];
  notes: string[];
}

export interface BackfillPlan {
  entries: BackfillEntryPlan[];
  /** Entries that are not from the seed (left alone). */
  skipped: { registrationNumber: string; name: string }[];
  /** Seed keys in the table that are not in this library. */
  missing: string[];
  /** Anything here stops an apply. */
  problems: string[];
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function isUnspecified(field: string, value: unknown): boolean {
  if (isEmpty(value)) return true;
  if (field === 'maturity') return false;
  if (typeof value === 'object' && value) {
    const v = value as Record<string, unknown>;
    const choice = v.method ?? v.schedule ?? v.kind;
    return choice === 'unspecified' && !v.detail;
  }
  return false;
}

/** Key order differs between jsonb and literals, so compare canonically. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value ?? null;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Reads the library and works out every change. Writes nothing. */
export async function planBackfillV2(tx: Transaction): Promise<BackfillPlan> {
  const rows = await tx
    .select({
      id: entries.id,
      number: entries.registrationNumber,
      name: entries.name,
      seedKey: entries.seedKey,
      builtStrategyId: entries.builtStrategyId,
      direction: entries.direction,
      parameters: entries.parameters,
      positionSizing: entries.positionSizing,
      stopLoss: entries.stopLoss,
      rebalanceSchedule: entries.rebalanceSchedule,
      maturity: entries.maturity,
      keyRisks: entries.keyRisks,
      dataNeeds: entries.dataNeeds,
      universe: entries.universe,
    })
    .from(entries)
    .orderBy(asc(entries.sequenceNo));

  const linked = rows.map((r) => r.builtStrategyId).filter((id): id is string => id !== null);
  const tested = new Set(
    linked.length
      ? (
          await tx
            .selectDistinct({ strategyId: backtestRuns.strategyId })
            .from(backtestRuns)
            .where(
              and(
                inArray(backtestRuns.strategyId, linked),
                eq(backtestRuns.status, 'completed'),
                isNotNull(backtestRuns.finishedAt),
              ),
            )
        ).map((r) => r.strategyId)
      : [],
  );

  const bySeedNumber = new Map<string, SeedEntry[]>();
  for (const s of STRATEGY_LIBRARY_SEED) {
    for (const n of [s.expectedNumber, s.v1Number]) {
      bySeedNumber.set(n, [...(bySeedNumber.get(n) ?? []), s]);
    }
  }
  const problems: string[] = [];
  const plan: BackfillEntryPlan[] = [];
  const skipped: BackfillPlan['skipped'] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    // A seed entry registered by hand (through the form or the API) has no seed
    // key; it is recognised by its seed number and its exact seed name.
    const seedKey =
      r.seedKey ?? bySeedNumber.get(r.number)?.find((s) => s.input.name === r.name)?.seedKey;
    const row = seedKey ? LIBRARY_V2_BACKFILL[seedKey] : undefined;
    if (!seedKey || !row || seen.has(seedKey)) {
      skipped.push({ registrationNumber: r.number, name: r.name });
      continue;
    }
    seen.add(seedKey);
    const notes = r.seedKey ? [] : ['Matched to the seed by number and name (registered by hand).'];
    // The table must pass the same rules a person's edit does.
    const checked = libraryV2Fields.safeParse({ ...row.values, maturity: 'researched' });
    if (!checked.success) {
      problems.push(`${r.number}: ${checked.error.issues.map((i) => i.message).join('; ')}`);
      continue;
    }
    const derived: LibraryMaturity =
      r.builtStrategyId && tested.has(r.builtStrategyId) ? 'backtested' : 'researched';
    const target: LibraryV2Fields = { ...checked.data, maturity: derived };
    const current: Record<string, unknown> = r;
    const fields: BackfillFieldPlan[] = LIBRARY_V2_FIELD_NAMES.map((field) => {
      const value = target[field] ?? null;
      const now = current[field] ?? null;
      let action: FieldAction;
      if (same(now, value)) action = 'same';
      else if (field === 'maturity') {
        // Only Researched is derived over; anything else was set by a person.
        action = now === 'researched' ? 'set' : 'kept';
      } else action = isEmpty(now) ? 'set' : 'kept';
      const source =
        field === 'maturity'
          ? derived === 'backtested'
            ? 'linked Lab strategy has a completed back test'
            : r.builtStrategyId
              ? 'linked Lab strategy has no completed back test'
              : 'not linked to a Lab strategy'
          : (row.sources?.[field as BackfillField] ?? DEFAULT_SOURCES[field as BackfillField]);
      return {
        field,
        action,
        value,
        current: now,
        source,
        unspecified: isUnspecified(field, value),
      };
    });
    plan.push({
      entryId: r.id,
      registrationNumber: r.number,
      name: r.name,
      seedKey,
      fields,
      notes: [...notes, ...(row.notes ?? [])],
    });
  }
  const missing = Object.keys(LIBRARY_V2_BACKFILL).filter((k) => !seen.has(k));
  return { entries: plan, skipped, missing, problems };
}

export interface BackfillResult extends BackfillPlan {
  updated: number;
}

/** Plans, refuses on any problem, then writes the `set` fields with one history row per entry. */
export async function applyBackfillV2(tx: Transaction): Promise<BackfillResult> {
  const plan = await planBackfillV2(tx);
  if (plan.problems.length) {
    throw new Error(`Backfill refused:\n- ${plan.problems.join('\n- ')}`);
  }
  let updated = 0;
  for (const e of plan.entries) {
    const set = e.fields.filter((f) => f.action === 'set');
    if (!set.length) continue;
    await tx
      .update(entries)
      .set({
        ...Object.fromEntries(set.map((f) => [f.field, f.value])),
        updatedAt: new Date(),
        rowVersion: sql`${entries.rowVersion} + 1`,
      })
      .where(eq(entries.id, e.entryId));
    await tx.insert(revisions).values({
      entryId: e.entryId,
      action: 'edit',
      note: BACKFILL_NOTE,
      changedFields: set.map((f) => f.field),
      editedBy: null,
    });
    updated += 1;
  }
  return { ...plan, updated };
}
