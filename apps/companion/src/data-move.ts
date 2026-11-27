import {
  RESEARCH_EXPORT_TABLES,
  type ResearchExportAnswer,
  type ResearchExportTable,
} from '@tm/db';
import type postgres from 'postgres';
import type { CloudData } from './cloud-data';

/**
 * The data move (ADR 0122, S2 step 5): copies the cloud's research tables
 * into the companion's local store, the way S1 moved them out of Core
 * (ADR 0115). Each table is read in slices of physical pages through a data
 * request and inserted with ON CONFLICT DO NOTHING, so a run can be repeated
 * and nothing local is overwritten. A move verifies when a second pass
 * copies nothing, leaves nothing out, and every local table holds at least
 * the cloud's rows. The cloud's copies are never touched here.
 */

export interface TableCopy {
  table: ResearchExportTable;
  cloudRows: number;
  localBefore: number;
  inserted: number;
  /** Rows left out because their parent wasn't in the local store (should be 0). */
  skipped: number;
  localAfter: number;
}

/** Rows whose parent must already be there (a foreign key inside the Research Store). */
const PARENT_CHECK: Partial<Record<ResearchExportTable, string>> = {
  option_chain_snapshot: 'contract_id in (select id from option_contract)',
  pattern: 'scan_id in (select id from pattern_scan)',
  pattern_occurrence: 'pattern_id in (select id from pattern)',
};

const ident = (t: string) => `"${t.replace(/"/g, '""')}"`;

async function countRows(sql: postgres.Sql, table: string): Promise<number> {
  const [row] = await sql.unsafe<{ n: string }[]>(
    `select count(*)::text as n from ${ident(table)}`,
  );
  return Number(row?.n ?? 0);
}

async function localColumns(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select attname as name from pg_attribute
     where attrelid = ${table}::regclass and attnum > 0 and not attisdropped
     order by attnum`;
  return rows.map((r) => r.name);
}

export async function copyTable(
  sql: postgres.Sql,
  cloud: CloudData,
  table: ResearchExportTable,
  log: (line: string) => void = () => undefined,
): Promise<TableCopy> {
  const localBefore = await countRows(sql, table);
  const local = await localColumns(sql, table);
  let cloudRows = 0;
  let inserted = 0;
  let skipped = 0;
  let fromPage = 0;
  let pages = 0;
  do {
    const answer = await cloud.ask<ResearchExportAnswer>('research_export', {
      table,
      fromPage,
      ...(fromPage === 0 ? { count: true } : {}),
    });
    if (answer.rowCount !== undefined) cloudRows = answer.rowCount;
    if (answer.columns.join(',') !== local.join(','))
      throw new Error(
        `${table}: columns differ between the cloud and this computer (${answer.columns} vs ${local})`,
      );
    pages = answer.pages;
    if (answer.n > 0) {
      const list = answer.columns.map(ident).join(', ');
      const source = `json_populate_recordset(null::${ident(table)}, $1::text::json)`;
      const check = PARENT_CHECK[table];
      const result = await sql.begin(async (tx) => {
        const rows = await tx.unsafe(
          `insert into ${ident(table)} (${list}) select ${list} from ${source}` +
            (check ? ` where ${check}` : '') +
            ` on conflict do nothing`,
          [answer.rows],
        );
        const parentless = check
          ? Number(
              (
                await tx.unsafe<{ n: string }[]>(
                  `select count(*)::text as n from ${source} where not (${check})`,
                  [answer.rows],
                )
              )[0]?.n ?? 0,
            )
          : 0;
        return { inserted: rows.count, parentless };
      });
      inserted += result.inserted;
      skipped += result.parentless;
      log(
        `${table}: pages ${answer.fromPage}-${Math.min(answer.toPage, pages)} of ${pages}: ${answer.n} read, ${result.inserted} new`,
      );
    }
    fromPage = answer.toPage;
  } while (fromPage <= pages);
  const localAfter = await countRows(sql, table);
  return { table, cloudRows, localBefore, inserted, skipped, localAfter };
}

/** Copies every exported research table, parents first. */
export async function copyResearchTables(
  sql: postgres.Sql,
  cloud: CloudData,
  options: { tables?: readonly ResearchExportTable[]; log?: (line: string) => void } = {},
): Promise<TableCopy[]> {
  const out: TableCopy[] = [];
  for (const table of options.tables ?? RESEARCH_EXPORT_TABLES) {
    const copied = await copyTable(sql, cloud, table, options.log);
    options.log?.(
      `${table}: cloud ${copied.cloudRows}, here ${copied.localBefore} → ${copied.localAfter} (${copied.inserted} copied, ${copied.skipped} without parent)`,
    );
    out.push(copied);
  }
  return out;
}

/** A pass verifies when it copied nothing, left nothing out, and this computer holds every cloud row. */
export function copyVerified(copies: readonly TableCopy[]): boolean {
  return (
    copies.length === RESEARCH_EXPORT_TABLES.length &&
    copies.every((c) => c.inserted === 0 && c.skipped === 0 && c.localAfter >= c.cloudRows)
  );
}

/** The move: a copy pass, then a verifying pass. */
export async function moveResearchData(
  sql: postgres.Sql,
  cloud: CloudData,
  log: (line: string) => void = () => undefined,
): Promise<{ copy: TableCopy[]; verify: TableCopy[]; verified: boolean }> {
  log('Copying the cloud research tables to this computer…');
  const copy = await copyResearchTables(sql, cloud, { log });
  log('Checking the copy: a second pass should copy nothing…');
  const verify = await copyResearchTables(sql, cloud, { log });
  const verified = copyVerified(verify);
  if (verified) await markCloudCopies(sql, cloud, log);
  return { copy, verify, verified };
}

/** The id of everything marked as sent because it came from the cloud (never a real push id). */
export const FROM_CLOUD_PUSH_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Marks the outputs the move copied from the cloud as already sent, so the
 * companion never pushes them back as its own (ADR 0122): finished scans,
 * the decay scores of their patterns, ML evaluations and reports. Only rows
 * the cloud holds are marked; anything made here and not sent stays unsent.
 * Reads the four small tables again through the same export, so it can run
 * on its own on a store moved before this existed.
 */
export async function markCloudCopies(
  sql: postgres.Sql,
  cloud: CloudData,
  log: (line: string) => void = () => undefined,
): Promise<Record<string, number>> {
  const rowsOf = async (table: ResearchExportTable): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    let fromPage = 0;
    let pages = 0;
    do {
      const answer = await cloud.ask<ResearchExportAnswer>('research_export', { table, fromPage });
      out.push(...(JSON.parse(answer.rows) as Record<string, unknown>[]));
      pages = answer.pages;
      fromPage = answer.toPage;
    } while (fromPage <= pages);
    return out;
  };
  // The cloud's own values decide, not the local copy's: a scan or score made here since stays unsent.
  const scans = await rowsOf('pattern_scan');
  const patterns = (await rowsOf('pattern')).filter((p) => p.status === 'verified');
  const evaluations = await rowsOf('ml_evaluation');
  const reports = await rowsOf('ml_report');
  const mark = async (kind: string, keys: string[]) => {
    if (keys.length === 0) return 0;
    const rows = await sql`
      insert into companion.pushed (client_key, kind, push_id)
      select k, ${kind}, ${FROM_CLOUD_PUSH_ID}::uuid from unnest(${keys}::text[]) as k
      on conflict do nothing`;
    return rows.count;
  };
  const scored = patterns.filter((p) => p.last_scored != null && p.decay_stats != null);
  // The same key the decay push uses, with the hash taken over Postgres's own jsonb text.
  const decayKeys = scored.length
    ? (
        await sql<{ key: string }[]>`
          select 'decay:' || s.id || ':' || s.last_scored || ':' || md5(s.stats::jsonb::text) as key
          from jsonb_to_recordset(${JSON.stringify(
            scored.map((p) => ({ id: p.id, last_scored: p.last_scored, stats: p.decay_stats })),
          )}::text::jsonb) as s(id text, last_scored text, stats jsonb)`
      ).map((r) => r.key)
    : [];
  // The cloud's last score of each pattern, so a later score sends only newer evidence.
  if (patterns.length)
    await sql`
      insert into companion.decay_pulled (pattern_id, last_scored)
      select s.id, s.last_scored from jsonb_to_recordset(${JSON.stringify(
        patterns.map((p) => ({ id: p.id, last_scored: p.last_scored ?? null })),
      )}::text::jsonb) as s(id uuid, last_scored date)
      on conflict (pattern_id) do nothing`;
  const marked = {
    scans: await mark(
      'pattern_scan_result',
      scans
        .filter((r) => r.status === 'done' || r.status === 'failed')
        .map((r) => `scan:${String(r.id)}`),
    ),
    decayScores: await mark('pattern_decay', decayKeys),
    evaluations: await mark(
      'ml_evaluation',
      evaluations.map((r) => `eval:${String(r.model_run_id)}`),
    ),
    reports: await mark(
      'ml_report',
      reports.map((r) => `report:${String(r.id)}`),
    ),
  };
  log(`Marked as already in the cloud: ${JSON.stringify(marked)}`);
  return marked;
}
