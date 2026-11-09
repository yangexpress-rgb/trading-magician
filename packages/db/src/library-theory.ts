import {
  composeRegistrationNumber,
  layoutOf,
  renumberV3Note,
  RENUMBER_V3_FIELDS,
  THEORY_RECORD_TYPE,
  v3NumberFor,
  type ConventionTables,
  type ConventionVersion,
} from '@tm/domain';
import { asc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { listConventionVersions, resolveLibraryEntryRow } from './library';
import {
  conventionVersions,
  strategyLibraryEntries as entries,
  strategyLibraryRevisions as revisions,
  strategyLibrarySequence,
} from './schema';
import { V2_LABEL } from './library-renumber';

/**
 * Convention v3 (N181, ADR 0064): Library entries are theories, so their
 * numbers carry the record-type letter T. v3 is v2 with one record type,
 * T (Theory); every v2 entry is renumbered from its stored codes and sequence
 * by the database's single exempt path (`strategy_library_renumber`), which
 * keeps the old number as a former number, so S00001-SD keeps resolving to
 * T00001-SD. Related lists are rewritten, the sequence counter is untouched,
 * and the v3 row is added in the same transaction, so the library is never
 * half S and half T. Runs after the migrations (owner connection); a library
 * still on v1 is left alone until it is renumbered to v2.
 */

export const V3_LABEL = 'v3';

export function v3Definition(v2: ConventionVersion, effectiveFrom: string): ConventionVersion {
  return {
    label: V3_LABEL,
    effectiveFrom,
    tables: { ...v2.tables, recordType: [{ ...THEORY_RECORD_TYPE }] },
    layout: 'sequence-first',
    sequenceDigits: 5,
  };
}

export type TheoryRenumberOutcome =
  | { kind: 'renumbered'; count: number; changes: { from: string; to: string }[] }
  | { kind: 'already_theories' }
  | { kind: 'not_on_v2'; reason: string };

/** Moves a v2 library to v3 in the caller's transaction. Idempotent. */
export async function applyRenumberV3(tx: Transaction): Promise<TheoryRenumberOutcome> {
  // Serialise with registrations and other boots on the sequence row.
  const [seq] = await tx
    .select({ last: strategyLibrarySequence.lastIssued })
    .from(strategyLibrarySequence)
    .for('update');
  const counter = seq?.last ?? 0;
  const versions = await listConventionVersions(tx);
  const v2 = versions.find((v) => v.label === V2_LABEL);
  const v3 = versions.find((v) => v.label === V3_LABEL);
  const rows = await tx
    .select({
      id: entries.id,
      number: entries.registrationNumber,
      version: entries.conventionVersion,
      sequenceNo: entries.sequenceNo,
      timeframe: entries.timeframeCode,
      assetClass: entries.assetClassCode,
      related: entries.relatedEntries,
      formerNumbers: entries.formerNumbers,
    })
    .from(entries)
    .orderBy(asc(entries.sequenceNo));
  const pending = rows.filter((r) => r.version !== V3_LABEL);
  if (v3 && !pending.length) return { kind: 'already_theories' };
  if (!v2) return { kind: 'not_on_v2', reason: 'convention v2 is not in place yet' };
  const off = pending.filter((r) => r.version !== V2_LABEL);
  if (off.length) {
    return {
      kind: 'not_on_v2',
      reason: `${off.length} entries are not on convention v2 (${off[0]?.number ?? ''} on ${off[0]?.version ?? ''})`,
    };
  }
  if (layoutOf(v2) !== 'sequence-first') {
    throw new Error('Convention v2 is not sequence-first; theory numbers refused');
  }
  const target = v3 ?? v3Definition(v2, new Date().toISOString().slice(0, 10));
  if (!v3) {
    await tx.insert(conventionVersions).values({
      label: target.label,
      effectiveFrom: target.effectiveFrom,
      tables: target.tables as ConventionTables,
      layout: 'sequence-first',
      sequenceDigits: 5,
      // After v2 even when both are added in one transaction (a new install):
      // the latest-created version of a day is the one in effect.
      createdAt: sql`clock_timestamp()`,
    });
  }

  const toNew = new Map<string, string>();
  for (const r of rows) {
    const next = r.version === V3_LABEL ? r.number : v3NumberFor(r.number);
    if (!next) throw new Error(`${r.number} is not a v2 number; theory numbers refused`);
    for (const n of [r.number, ...r.formerNumbers]) toNew.set(n, next);
  }
  const changes: { from: string; to: string }[] = [];
  for (const r of pending) {
    const expected = composeRegistrationNumber(
      target,
      { recordType: THEORY_RECORD_TYPE.code, timeframe: r.timeframe, assetClass: r.assetClass },
      r.sequenceNo,
    );
    if (expected !== toNew.get(r.number)) {
      throw new Error(`${r.number}: stored codes compose ${expected}, not ${toNew.get(r.number)}`);
    }
    const result = await tx.execute(
      sql`select strategy_library_renumber(${r.id}::uuid, ${V3_LABEL}) as n`,
    );
    const issued = (result as unknown as { n: string }[])[0]?.n;
    if (issued !== expected) {
      throw new Error(`${r.number} was renumbered ${issued ?? '(nothing)'}, expected ${expected}`);
    }
    await tx.insert(revisions).values({
      entryId: r.id,
      action: 'edit',
      note: renumberV3Note(expected, r.number),
      changedFields: [...RENUMBER_V3_FIELDS],
      editedBy: null,
    });
    changes.push({ from: r.number, to: expected });
  }
  for (const r of rows) {
    const after = r.related.map((n) => toNew.get(n) ?? n);
    if (JSON.stringify(after) !== JSON.stringify(r.related)) {
      await tx.update(entries).set({ relatedEntries: after }).where(eq(entries.id, r.id));
    }
  }
  // Checks before committing: each new and old number resolves to its entry.
  for (const c of changes) {
    const byNew = await resolveLibraryEntryRow(tx, c.to);
    const byOld = await resolveLibraryEntryRow(tx, c.from);
    if (!byNew || byNew.registrationNumber !== c.to || byOld?.id !== byNew.id) {
      throw new Error(`Theory renumber check failed for ${c.from} → ${c.to}`);
    }
  }
  const [after] = await tx
    .select({ last: strategyLibrarySequence.lastIssued })
    .from(strategyLibrarySequence);
  if ((after?.last ?? 0) !== counter) throw new Error('The sequence counter moved');
  return { kind: 'renumbered', count: changes.length, changes };
}

/** Its own transaction: all of the library becomes theories, or none of it. */
export async function renumberToTheories(db: Database): Promise<TheoryRenumberOutcome> {
  const outcome = await db.transaction((tx) => applyRenumberV3(tx));
  if (outcome.kind === 'renumbered' && outcome.count > 0) {
    process.stdout.write(
      `Strategy Library: ${outcome.count} entries renumbered as theories (${outcome.changes[0]?.from} → ${outcome.changes[0]?.to} …).\n`,
    );
  }
  return outcome;
}
