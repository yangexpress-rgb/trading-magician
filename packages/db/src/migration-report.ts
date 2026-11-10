import {
  migrateV1,
  migrateV2,
  migrateV3,
  parseDefinition,
  STRATEGY_SCHEMA_VERSION,
  validateStrategy,
  type MigrationNote,
} from '@tm/domain';
import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { loadValidationContext } from './strategies';
import { withTenant } from './tenant';

/**
 * The migration report of the Strategy Lab simplification (ADR 0049), What to
 * trade, Entry, Exit (ADR 0073) and the trailing stop in Exit when (ADR 0074):
 * every stored strategy draft and version older than the current schema, what
 * reading it converts, every form kept as saved (Exit-leg stop orders,
 * per-leg conditions, ranked legs, trailing stop rules under other Fire when),
 * and whether the migrated strategy validates. Read-only: stored versions are
 * never rewritten (they are migrated on every read).
 *
 *   pnpm --filter @tm/db strategies:migration-report
 */

/** Checks added by the simplification: strategies they now refuse were broken before. */
export const NEW_CHECKS = new Set([
  'cross_with_confirmation',
  'context_in_gate',
  'slots_timing_only',
  'risk_needs_distance',
  'atr_stop_no_distance',
  'risk_incomplete',
  // What to trade, Entry, Exit (ADR 0073).
  'group_needs_max_held',
  'left_group_without_group',
]);

/** Notes for reading a stored document as the current schema: each step from its version on. */
export function migrationNotes(doc: Record<string, unknown>): MigrationNote[] {
  const notes: MigrationNote[] = [];
  let d = doc;
  if (d.schemaVersion === 1) {
    const r = migrateV1(d);
    notes.push(...r.notes);
    d = r.doc;
  }
  if (d.schemaVersion === 2) {
    const r = migrateV2(d);
    notes.push(...r.notes);
    d = r.doc;
  }
  // The trailing stop moves into Exit when (ADR 0074).
  if (d.schemaVersion === 3) notes.push(...migrateV3(d).notes);
  return notes;
}

/** Kept-as-saved forms the builder no longer offers. */
const KEPT = new Set([
  'exit_leg_stop',
  'ranked_legs_kept',
  'leg_conditions_kept',
  'trailing_stop_kept',
]);

export interface MigrationReportEntry {
  userId: string;
  email: string | null;
  strategyId: string;
  strategyName: string;
  /** "draft", or the version number. */
  what: 'draft' | number;
  notes: MigrationNote[];
  /** Validation errors of the migrated definition (only for the draft and the newest version). */
  errors: { code: string; message: string; added: boolean }[] | undefined;
  /** The migrated document failed to parse: never expected, listed loudly. */
  parseError?: string;
}

type Row = {
  user_id: string;
  email: string | null;
  strategy_id: string;
  name: string;
  what: string;
  newest: boolean;
  schema_version: number;
  definition: Record<string, unknown>;
};

export async function strategyMigrationReport(db: Database): Promise<MigrationReportEntry[]> {
  const rows = [
    ...(await db.execute<Row>(sql`
      select s.user_id, u.email, s.id as strategy_id, s.name, 'draft' as what, true as newest,
             s.draft_schema_version as schema_version, s.draft_definition as definition
        from strategy s left join "user" u on u.id = s.user_id
       where s.deleted_at is null
      union all
      select v.user_id, u.email, v.strategy_id, s.name, v.version_no::text as what,
             v.version_no = max(v.version_no) over (partition by v.strategy_id) as newest,
             v.schema_version, v.definition
        from strategy_version v
        join strategy s on s.id = v.strategy_id
        left join "user" u on u.id = v.user_id
       where s.deleted_at is null
       order by 1, 4, 3, 5`)),
  ];
  const contexts = new Map<string, Awaited<ReturnType<typeof loadValidationContext>>>();
  const out: MigrationReportEntry[] = [];
  for (const r of rows) {
    if (r.schema_version >= STRATEGY_SCHEMA_VERSION) continue;
    const entry: MigrationReportEntry = {
      userId: r.user_id,
      email: r.email,
      strategyId: r.strategy_id,
      strategyName: r.name,
      what: r.what === 'draft' ? 'draft' : Number(r.what),
      notes: migrationNotes(r.definition),
      errors: undefined,
    };
    try {
      const def = parseDefinition(r.definition);
      if (r.newest) {
        let ctx = contexts.get(r.user_id);
        if (!ctx) {
          ctx = await withTenant(db, { userId: r.user_id }, (tx) => loadValidationContext(tx));
          contexts.set(r.user_id, ctx);
        }
        entry.errors = validateStrategy(def, ctx).errors.map((e) => ({
          code: e.code,
          message: e.message,
          added: NEW_CHECKS.has(e.code),
        }));
      }
    } catch (e) {
      entry.parseError = e instanceof Error ? e.message : String(e);
    }
    out.push(entry);
  }
  return out;
}

/** The report as Markdown: changes and grandfathered forms first, then the rest. */
export function formatMigrationReport(entries: MigrationReportEntry[]): string {
  const lines: string[] = [
    `# Strategy Lab: migration report (schema ${STRATEGY_SCHEMA_VERSION})`,
    '',
  ];
  const strategies = new Set(entries.map((e) => e.strategyId));
  const stops = entries.flatMap((e) =>
    e.notes.filter((n) => KEPT.has(n.code)).map((n) => ({ e, n })),
  );
  const changes = entries.filter((e) => e.notes.some((n) => n.effect === 'changes'));
  const refused = entries.filter((e) => e.errors?.some((x) => x.added));
  const broken = entries.filter((e) => e.parseError);
  lines.push(
    `${strategies.size} strategies, ${entries.length} stored drafts and versions read as schema ${STRATEGY_SCHEMA_VERSION}.`,
    `${changes.length} with a behaviour change, ${stops.length} forms kept as saved, ` +
      `${refused.length} refused by a new check, ${broken.length} that do not parse.`,
    '',
  );
  const label = (e: MigrationReportEntry) =>
    `${e.strategyName} (${e.what === 'draft' ? 'draft' : `version ${e.what}`}) · ${e.email ?? e.userId}`;
  if (broken.length > 0) {
    lines.push('## Do not parse', '');
    for (const e of broken) lines.push(`- ${label(e)}: ${e.parseError}`);
    lines.push('');
  }
  lines.push('## Kept as saved (Exit-leg stop orders, per-leg conditions, ranked legs)', '');
  if (stops.length === 0) lines.push('None.');
  for (const { e, n } of stops) lines.push(`- ${label(e)} · ${n.where}: ${n.message}`);
  lines.push('', '## Refused by a new check', '');
  if (refused.length === 0) lines.push('None.');
  for (const e of refused)
    for (const x of (e.errors ?? []).filter((y) => y.added))
      lines.push(`- ${label(e)}: ${x.code}: ${x.message}`);
  lines.push('', '## Every converted strategy', '');
  for (const e of entries) {
    lines.push(`### ${label(e)}`, '');
    if (e.notes.length === 0) lines.push('- Nothing to convert.');
    for (const n of e.notes) lines.push(`- [${n.effect}] ${n.where}: ${n.message}`);
    if (e.errors)
      lines.push(
        e.errors.length === 0
          ? '- Validates.'
          : `- Validation errors: ${e.errors.map((x) => x.code).join(', ')}`,
      );
    lines.push('');
  }
  return lines.join('\n');
}
