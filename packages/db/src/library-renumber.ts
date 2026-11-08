import {
  composeRegistrationNumber,
  ConventionCodeError,
  LIBRARY_V2_RENUMBER_TABLE,
  layoutOf,
  parseRegistrationNumber,
  RENUMBER_V2_FIELDS,
  renumberV2Note,
  type ConventionTables,
  type ConventionVersion,
} from '@tm/domain';
import { asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import { listConventionVersions, resolveLibraryEntryRow } from './library';
import {
  conventionVersions,
  strategies,
  strategyLibraryEntries as entries,
  strategyLibraryRevisions as revisions,
  strategyLibrarySequence,
} from './schema';

/**
 * The convention v2 renumbering (ADR 0055, brief "Strategy Library v2" §1.3).
 *
 * One controlled migration moves every entry from its v1 number to its v2
 * number: the new number is composed from the entry's stored sequence and
 * codes (never by parsing the old string), checked against the brief's table
 * for sequences 1–31, and written by the database's single exempt path
 * (`strategy_library_renumber`), which keeps the old number as a former
 * number. Related lists are rewritten to v2. The v2 convention row is added
 * in the same transaction, so the library is never half v1 and half v2. The
 * sequence counter is not touched. Owner connection only.
 */

export const V2_LABEL = 'v2';

export interface RenumberPlanRow {
  entryId: string;
  sequenceNo: number;
  name: string;
  seedKey: string | null;
  oldNumber: string;
  newNumber: string;
  /** `renumber`: will change. `already_v2`: renumbered by an earlier run. */
  action: 'renumber' | 'already_v2';
  /** Whether the brief's table has a row for this sequence (1–31). */
  inTable: boolean;
  relatedBefore: string[];
  relatedAfter: string[];
  builtStrategyName: string | null;
}

export interface RenumberPlan {
  rows: RenumberPlanRow[];
  /** Anything here stops the run: nothing is written. */
  problems: string[];
  counter: number;
  v2Exists: boolean;
  /** What the register form would preview next for Days + Stock, after the run. */
  nextPreview: string;
}

/** v2 as the brief defines it: v1's code tables, sequence-first, five digits. */
export function v2Definition(v1: ConventionVersion, effectiveFrom: string): ConventionVersion {
  return {
    label: V2_LABEL,
    effectiveFrom,
    tables: v1.tables,
    layout: 'sequence-first',
    sequenceDigits: 5,
  };
}

function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Reads the library and works out every change. Writes nothing. */
export async function planRenumberV2(tx: Transaction): Promise<RenumberPlan> {
  const problems: string[] = [];
  const versions = await listConventionVersions(tx);
  const v1 = versions.find((v) => v.label === 'v1');
  if (!v1) throw new Error('Convention v1 is missing');
  const existingV2 = versions.find((v) => v.label === V2_LABEL);
  const v2 = existingV2 ?? v2Definition(v1, utcDay());
  if (existingV2) {
    if (layoutOf(existingV2) !== 'sequence-first' || existingV2.sequenceDigits !== 5) {
      problems.push('Convention v2 exists but is not sequence-first with five digits');
    }
    if (JSON.stringify(existingV2.tables) !== JSON.stringify(v1.tables)) {
      problems.push('Convention v2 exists with code tables different from v1');
    }
  }
  const later = versions.filter((v) => v.label !== 'v1' && v.label !== V2_LABEL);
  if (later.length) {
    problems.push(`Unexpected convention versions: ${later.map((v) => v.label).join(', ')}`);
  }

  const rows = await tx
    .select({
      id: entries.id,
      sequenceNo: entries.sequenceNo,
      name: entries.name,
      seedKey: entries.seedKey,
      number: entries.registrationNumber,
      version: entries.conventionVersion,
      formerNumbers: entries.formerNumbers,
      recordType: entries.recordTypeCode,
      timeframe: entries.timeframeCode,
      assetClass: entries.assetClassCode,
      related: entries.relatedEntries,
      builtStrategyId: entries.builtStrategyId,
      builtStrategyName: strategies.name,
    })
    .from(entries)
    .leftJoin(strategies, eq(strategies.id, entries.builtStrategyId))
    .orderBy(asc(entries.sequenceNo));

  const plan: RenumberPlanRow[] = [];
  const toNew = new Map<string, string>();
  for (const r of rows) {
    const codes = { recordType: r.recordType, timeframe: r.timeframe, assetClass: r.assetClass };
    let newNumber: string;
    let oldNumber: string;
    let action: RenumberPlanRow['action'];
    if (r.version === V2_LABEL) {
      action = 'already_v2';
      newNumber = r.number;
      oldNumber = r.formerNumbers.at(-1) ?? r.number;
    } else {
      action = 'renumber';
      oldNumber = r.number;
      try {
        newNumber = composeRegistrationNumber(v2, codes, r.sequenceNo);
      } catch (error) {
        if (!(error instanceof ConventionCodeError)) throw error;
        problems.push(`${r.number}: ${error.message}`);
        continue;
      }
      // The old number must be what v1 issues for the stored codes, too.
      const v1Again = composeRegistrationNumber(v1, codes, r.sequenceNo);
      if (v1Again !== r.number) {
        problems.push(`${r.number}: stored codes and sequence compose ${v1Again} under v1`);
      }
    }
    const table = LIBRARY_V2_RENUMBER_TABLE.find((t) => t.seq === r.sequenceNo);
    if (table && (table.old !== oldNumber || table.new !== newNumber)) {
      problems.push(
        `Sequence ${r.sequenceNo}: the library has ${oldNumber} → ${newNumber}, the brief's table says ${table.old} → ${table.new}`,
      );
    }
    toNew.set(oldNumber, newNumber);
    for (const f of r.formerNumbers) toNew.set(f, newNumber);
    toNew.set(newNumber, newNumber);
    plan.push({
      entryId: r.id,
      sequenceNo: r.sequenceNo,
      name: r.name,
      seedKey: r.seedKey,
      oldNumber,
      newNumber,
      action,
      inTable: table !== undefined,
      relatedBefore: r.related,
      relatedAfter: [],
      builtStrategyName: r.builtStrategyId ? (r.builtStrategyName ?? '(another workspace)') : null,
    });
  }
  const seqs = rows.map((r) => r.sequenceNo);
  for (const t of LIBRARY_V2_RENUMBER_TABLE) {
    if (!seqs.includes(t.seq)) problems.push(`Sequence ${t.seq} (${t.old}) is not in the library`);
  }
  for (const row of plan) {
    row.relatedAfter = row.relatedBefore.map((n) => {
      const mapped = toNew.get(n);
      if (!mapped) problems.push(`${row.oldNumber} relates to ${n}, which has no v2 number`);
      return mapped ?? n;
    });
  }
  const news = plan.map((p) => p.newNumber);
  if (new Set(news).size !== news.length) problems.push('Two entries would get the same number');

  const [seq] = await tx
    .select({ last: strategyLibrarySequence.lastIssued })
    .from(strategyLibrarySequence);
  const counter = seq?.last ?? 0;
  const nextPreview = composeRegistrationNumber(
    v2,
    { recordType: 'S', timeframe: 'D', assetClass: 'S' },
    counter + 1,
  );
  return { rows: plan, problems, counter, v2Exists: existingV2 !== undefined, nextPreview };
}

export interface RenumberResult extends RenumberPlan {
  renumbered: number;
  verification: string[];
}

/**
 * Plans, refuses on any problem, then renumbers. Adds the v2 row (effective
 * today, UTC) if it is not there. Verifies before returning; a failed check
 * throws, rolling the transaction back.
 */
export async function applyRenumberV2(tx: Transaction): Promise<RenumberResult> {
  const plan = await planRenumberV2(tx);
  if (plan.problems.length) {
    throw new Error(`Renumbering refused:\n- ${plan.problems.join('\n- ')}`);
  }
  if (!plan.v2Exists) {
    const v1 = (await listConventionVersions(tx)).find((v) => v.label === 'v1');
    if (!v1) throw new Error('Convention v1 is missing');
    const v2 = v2Definition(v1, utcDay());
    await tx.insert(conventionVersions).values({
      label: v2.label,
      effectiveFrom: v2.effectiveFrom,
      tables: v2.tables as ConventionTables,
      layout: 'sequence-first',
      sequenceDigits: 5,
    });
  }
  let renumbered = 0;
  for (const row of plan.rows) {
    if (row.action === 'renumber') {
      const result = await tx.execute(
        sql`select strategy_library_renumber(${row.entryId}::uuid, ${V2_LABEL}) as n`,
      );
      const issued = (result as unknown as { n: string }[])[0]?.n;
      if (issued !== row.newNumber) {
        throw new Error(`${row.oldNumber} was renumbered ${issued}, expected ${row.newNumber}`);
      }
      await tx.insert(revisions).values({
        entryId: row.entryId,
        action: 'edit',
        note: renumberV2Note(row.newNumber, row.oldNumber),
        changedFields: [...RENUMBER_V2_FIELDS],
        editedBy: null,
      });
      renumbered += 1;
    }
    if (JSON.stringify(row.relatedAfter) !== JSON.stringify(row.relatedBefore)) {
      await tx
        .update(entries)
        .set({ relatedEntries: row.relatedAfter })
        .where(eq(entries.id, row.entryId));
    }
  }
  const verification = await verifyRenumberV2(tx, plan);
  return { ...plan, renumbered, verification };
}

/** The brief's checks after applying (§1.3); throws on the first failure. */
export async function verifyRenumberV2(tx: Transaction, plan: RenumberPlan): Promise<string[]> {
  const fail = (m: string): never => {
    throw new Error(`Renumber check failed: ${m}`);
  };
  const lines: string[] = [];
  for (const row of plan.rows) {
    const byNew = await resolveLibraryEntryRow(tx, row.newNumber);
    if (!byNew || byNew.id !== row.entryId) {
      return fail(`${row.newNumber} does not resolve to its entry`);
    }
    if (byNew.conventionVersion !== V2_LABEL) fail(`${row.newNumber} is not on v2`);
    if (row.oldNumber !== row.newNumber) {
      const byOld = await resolveLibraryEntryRow(tx, row.oldNumber);
      if (byOld?.id !== row.entryId) fail(`${row.oldNumber} does not resolve to ${row.newNumber}`);
    }
    for (const n of byNew.relatedEntries) {
      const rel = await resolveLibraryEntryRow(tx, n);
      if (!rel || rel.registrationNumber !== n) {
        fail(`${row.newNumber} relates to ${n}, which is not a current number`);
      }
      if (parseRegistrationNumber(n)?.layout !== 'sequence-first') {
        fail(`${row.newNumber} still relates to a v1 number (${n})`);
      }
    }
  }
  lines.push(`${plan.rows.length} entries resolve by their v2 number`);
  lines.push(
    `${plan.rows.filter((r) => r.oldNumber !== r.newNumber).length} old numbers resolve to the same entries`,
  );
  lines.push('every related link resolves to a v2 number');
  const [seq] = await tx
    .select({ last: strategyLibrarySequence.lastIssued })
    .from(strategyLibrarySequence);
  if ((seq?.last ?? 0) !== plan.counter) fail(`the counter moved from ${plan.counter}`);
  lines.push(
    `the counter still reads ${plan.counter}; the next Days + Stock is ${plan.nextPreview}`,
  );
  return lines;
}
