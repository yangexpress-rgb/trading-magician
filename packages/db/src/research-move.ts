import { pipeline } from 'node:stream/promises';
import type postgres from 'postgres';
import { RESEARCH_TABLES, type ResearchTable } from './research';

/**
 * Moves the research tables from Core into the Research Store (ADR 0115).
 *
 * Copying never deletes anything. Each table is read in slices of physical
 * pages (TID ranges), streamed with COPY into a temporary table on the
 * Research side, and inserted with ON CONFLICT DO NOTHING, so a run can be
 * repeated: rows already there (including rows the worker wrote after the
 * switch) are kept as they are. The proof that every Core row arrived is a
 * second run that inserts nothing, plus the per-table counts.
 *
 * Clearing Core's copies is a separate, explicit step (`clearCoreCopies`),
 * refused unless the last verification matched.
 */

export interface TableMove {
  table: ResearchTable;
  coreRows: number;
  researchBefore: number;
  inserted: number;
  /** Rows left out because their parent wasn't in the Research Store (should be 0). */
  skipped: number;
  researchAfter: number;
}

const PAGES_PER_SLICE = 8192; // 64 MB of heap per slice

/** Rows whose parent must already be there (a foreign key inside the Research Store). */
const PARENT_CHECK: Partial<Record<ResearchTable, string>> = {
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

async function pages(sql: postgres.Sql, table: string): Promise<number> {
  const [row] = await sql.unsafe<{ n: string }[]>(
    `select (pg_relation_size(${`'${table}'`}::regclass) / current_setting('block_size')::int)::text as n`,
  );
  return Number(row?.n ?? 0);
}

async function columns(sql: postgres.Sql, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select attname as name from pg_attribute
     where attrelid = ${table}::regclass and attnum > 0 and not attisdropped
     order by attnum`;
  return rows.map((r) => r.name);
}

export async function moveTable(
  core: postgres.Sql,
  research: postgres.Sql,
  table: ResearchTable,
  log: (line: string) => void = () => undefined,
): Promise<TableMove> {
  const coreRows = await countRows(core, table);
  const researchBefore = await countRows(research, table);
  // Both sides must have the same columns, in the same order, for COPY.
  const cols = await columns(core, table);
  const rcols = await columns(research, table);
  if (cols.join(',') !== rcols.join(','))
    throw new Error(`${table}: columns differ between Core and Research (${cols} vs ${rcols})`);
  const list = cols.map(ident).join(', ');
  const total = await pages(core, table);
  let inserted = 0;
  let skipped = 0;
  for (let from = 0; from <= total; from += PAGES_PER_SLICE) {
    const to = from + PAGES_PER_SLICE;
    const where = `ctid >= '(${from},0)'::tid and ctid < '(${to},0)'::tid`;
    const result = await research.begin(async (tx) => {
      await tx.unsafe(
        `create temp table move_stage (like ${ident(table)} including defaults) on commit drop`,
      );
      const reader = await core
        .unsafe(`copy (select ${list} from ${ident(table)} where ${where}) to stdout`)
        .readable();
      const writer = await tx.unsafe(`copy move_stage (${list}) from stdin`).writable();
      await pipeline(reader, writer);
      const check = PARENT_CHECK[table];
      const [staged] = await tx.unsafe<{ n: string }[]>(
        `select count(*)::text as n from move_stage`,
      );
      const rows = await tx.unsafe(
        `insert into ${ident(table)} (${list}) select ${list} from move_stage` +
          (check ? ` where ${check}` : '') +
          ` on conflict do nothing`,
      );
      const parentless = check
        ? Number(
            (
              await tx.unsafe<{ n: string }[]>(
                `select count(*)::text as n from move_stage where not (${check})`,
              )
            )[0]?.n ?? 0,
          )
        : 0;
      return { staged: Number(staged?.n ?? 0), inserted: rows.count, parentless };
    });
    inserted += result.inserted;
    skipped += result.parentless;
    if (result.staged > 0)
      log(
        `${table}: pages ${from}-${Math.min(to, total)} of ${total}: ${result.staged} read, ${result.inserted} new`,
      );
  }
  const researchAfter = await countRows(research, table);
  return { table, coreRows, researchBefore, inserted, skipped, researchAfter };
}

/** Copies every research table, parents first. */
export async function moveResearchTables(
  core: postgres.Sql,
  research: postgres.Sql,
  options: { tables?: readonly ResearchTable[]; log?: (line: string) => void } = {},
): Promise<TableMove[]> {
  const out: TableMove[] = [];
  for (const table of options.tables ?? RESEARCH_TABLES) {
    const moved = await moveTable(core, research, table, options.log);
    options.log?.(
      `${table}: Core ${moved.coreRows}, Research ${moved.researchBefore} → ${moved.researchAfter} (${moved.inserted} copied, ${moved.skipped} without parent)`,
    );
    out.push(moved);
  }
  return out;
}

/**
 * A move verifies when a repeat copied nothing, left nothing out, and the
 * Research Store holds at least as many rows as Core for every table.
 */
export function verified(moves: readonly TableMove[]): boolean {
  return moves.every((m) => m.inserted === 0 && m.skipped === 0 && m.researchAfter >= m.coreRows);
}

/**
 * Empties Core's copies of the research tables, only after a verifying move.
 * Children first. TRUNCATE frees the disk at once (no dead rows left).
 */
export async function clearCoreCopies(
  core: postgres.Sql,
  moves: readonly TableMove[],
): Promise<void> {
  if (moves.length !== RESEARCH_TABLES.length || !verified(moves))
    throw new Error('Refused: the last move did not verify every research table');
  await core.unsafe(`truncate ${[...RESEARCH_TABLES].reverse().map(ident).join(', ')}`);
}
