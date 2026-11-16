import type { MigrationNote } from './migrate-v1';

/**
 * Schema version 5 → 6: the strategy trailing stop risk limit (N290,
 * ADR 0099). Yong chose (2026-11-16) that existing strategies get the same
 * 1% default as new ones, so a stored definition without the limit reads as
 * having it at 1%. A strategy saved from schema 6 on keeps whatever it says,
 * including no limit (the field left blank). Stored versions are never
 * rewritten; every read goes through this, as with the earlier steps.
 *
 * Works on plain JSON, before the schema parses it.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** The default the migration adds, as stored. */
export const MIGRATED_TRAILING_STOP_PCT = '1';

export function migrateV5(input: Json): { doc: Json; notes: MigrationNote[] } {
  const doc = structuredClone(input);
  const notes: MigrationNote[] = [];
  const risk: Json = isObj(doc.risk) ? doc.risk : {};
  if (risk.trailingStopPct === undefined) {
    risk.trailingStopPct = MIGRATED_TRAILING_STOP_PCT;
    notes.push({
      code: 'strategy_trailing_stop',
      effect: 'changes',
      message: `Risk limits now include a ${MIGRATED_TRAILING_STOP_PCT}% trailing stop: every position closes when the strategy falls more than ${MIGRATED_TRAILING_STOP_PCT}% of the money in its positions below its best since entry`,
      where: 'risk.trailingStopPct',
    });
  }
  doc.risk = risk;
  doc.schemaVersion = 6;
  return { doc, notes };
}
