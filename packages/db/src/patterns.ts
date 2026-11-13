import {
  type EventPath,
  type PatternAtom,
  type PatternScanConfig,
  type PatternStats,
  catalogueByCategory,
  FACTOR_CATEGORY_LABELS,
  hitRateWords,
  outcomeWords,
  promotedName,
  ruleWords,
  universeLabel,
  VERIFY,
  FACTOR_CATALOGUE_V1,
  FACTOR_CATEGORIES,
  MIN_CROSS_SECTION,
  type FactorCategory,
  type FactorValues,
} from '@tm/domain';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { LibraryError, registerLibraryEntry } from './library';
import {
  factorCoverage,
  factorSnapshots,
  instruments,
  patternOccurrences,
  patternScans,
  patterns,
  strategyLibraryEntries,
} from './schema';

/**
 * Pattern discovery's factor store (pattern brief §3, ADR 0091). Global
 * market data, written only by the worker's snapshot job, insert-only.
 */

type Db = Database | Transaction;

const CHUNK = 1000;

/** The coverage table's pseudo-factor that counts each day's snapshot rows. */
export const ROWS_FACTOR = '_rows';

export interface FactorSnapshotInput {
  instrumentId: string;
  asOf: string;
  values: FactorValues;
  closeRet: number | null;
  highRel: number | null;
  lowRel: number | null;
}

/** The latest snapshot date per instrument (absent: none yet). */
export async function latestSnapshotDates(
  db: Db,
  instrumentIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < instrumentIds.length; i += CHUNK) {
    const ids = instrumentIds.slice(i, i + CHUNK);
    const rows = await db
      .select({
        instrumentId: factorSnapshots.instrumentId,
        last: sql<string>`max(${factorSnapshots.asOf})::text`,
      })
      .from(factorSnapshots)
      .where(inArray(factorSnapshots.instrumentId, ids))
      .groupBy(factorSnapshots.instrumentId);
    for (const r of rows) out.set(r.instrumentId, r.last);
  }
  return out;
}

/**
 * Writes snapshot rows, skipping any already stored, and adds the rows it
 * did write to the coverage counts in the same transaction, so the counts
 * always match the rows. Returns how many were new.
 */
export async function saveFactorSnapshots(
  db: Database,
  rows: readonly FactorSnapshotInput[],
  catalogueVersion: number,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    written += await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(factorSnapshots)
        .values(
          chunk.map((r) => ({
            asOf: r.asOf,
            instrumentId: r.instrumentId,
            values: r.values,
            closeRet: r.closeRet,
            highRel: r.highRel,
            lowRel: r.lowRel,
            catalogueVersion,
          })),
        )
        .onConflictDoNothing()
        .returning({ asOf: factorSnapshots.asOf, instrumentId: factorSnapshots.instrumentId });
      if (inserted.length === 0) return 0;
      const fresh = new Set(inserted.map((r) => `${r.asOf}|${r.instrumentId}`));
      const counts = new Map<string, number>();
      const add = (factor: string, asOf: string) => {
        const k = `${factor}|${asOf}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      };
      for (const r of chunk) {
        if (!fresh.has(`${r.asOf}|${r.instrumentId}`)) continue;
        add(ROWS_FACTOR, r.asOf);
        for (const f of Object.keys(r.values)) add(f, r.asOf);
      }
      const values = [...counts].map(([k, known]) => {
        const [factor, asOf] = k.split('|') as [string, string];
        return { factor, asOf, known };
      });
      for (let j = 0; j < values.length; j += CHUNK)
        await tx
          .insert(factorCoverage)
          .values(values.slice(j, j + CHUNK))
          .onConflictDoUpdate({
            target: [factorCoverage.factor, factorCoverage.asOf],
            set: { known: sql`${factorCoverage.known} + excluded.known` },
          });
      return inserted.length;
    });
  }
  return written;
}

export interface FactorCoverageLine {
  factor: string;
  /** The first day any instrument had a value. */
  firstAny: string | null;
  /** The first day at least MIN_CROSS_SECTION instruments had one: where quintile atoms can form. */
  firstCross: string | null;
  last: string | null;
  /** Instrument-days with a value. */
  known: number;
  /** Days with at least one value. */
  days: number;
}

export interface FactorCoverageReport {
  /** Snapshot rows, days and first/last day overall. */
  rows: number;
  days: number;
  first: string | null;
  last: string | null;
  /** Instruments with at least one row. */
  instruments: number;
  /** On-disk size of the snapshot table with its indexes, in bytes. */
  tableBytes: number;
  factors: FactorCoverageLine[];
  /** Per category: the earliest first-any and first-cross day across its factors. */
  categories: {
    category: FactorCategory;
    firstAny: string | null;
    firstCross: string | null;
    factors: number;
    factorsWithData: number;
  }[];
}

/** The backfill coverage report (brief §3, §13): per factor and category, where values begin. */
export async function factorCoverageReport(db: Db): Promise<FactorCoverageReport> {
  const lines = await db
    .select({
      factor: factorCoverage.factor,
      firstAny: sql<string | null>`min(${factorCoverage.asOf})::text`,
      firstCross: sql<
        string | null
      >`min(${factorCoverage.asOf}) filter (where ${factorCoverage.known} >= ${MIN_CROSS_SECTION})::text`,
      last: sql<string | null>`max(${factorCoverage.asOf})::text`,
      known: sql<number>`coalesce(sum(${factorCoverage.known}), 0)::bigint`,
      days: sql<number>`count(*)::int`,
    })
    .from(factorCoverage)
    .groupBy(factorCoverage.factor)
    .orderBy(asc(factorCoverage.factor));
  const byFactor = new Map(lines.map((l) => [l.factor, { ...l, known: Number(l.known) }]));
  const rowsLine = byFactor.get(ROWS_FACTOR);
  const [meta] = await db.execute<{ instruments: number; bytes: string }>(sql`
    select
      (select count(distinct instrument_id) from factor_snapshot)::int as instruments,
      pg_total_relation_size('factor_snapshot')::text as bytes`);
  const factors: FactorCoverageLine[] = FACTOR_CATALOGUE_V1.map(
    (f) =>
      byFactor.get(f.id) ?? {
        factor: f.id,
        firstAny: null,
        firstCross: null,
        last: null,
        known: 0,
        days: 0,
      },
  );
  const minOf = (xs: (string | null)[]) =>
    xs.filter((x): x is string => x !== null).sort()[0] ?? null;
  const groups = catalogueByCategory();
  return {
    rows: rowsLine?.known ?? 0,
    days: rowsLine?.days ?? 0,
    first: rowsLine?.firstAny ?? null,
    last: rowsLine?.last ?? null,
    instruments: Number(meta?.instruments ?? 0),
    tableBytes: Number(meta?.bytes ?? 0),
    factors,
    categories: FACTOR_CATEGORIES.map((category) => {
      const own = factors.filter((l) => groups[category].includes(l.factor));
      return {
        category,
        firstAny: minOf(own.map((l) => l.firstAny)),
        firstCross: minOf(own.map((l) => l.firstCross)),
        factors: own.length,
        factorsWithData: own.filter((l) => l.known > 0).length,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Scans and patterns (brief §6–§8): the owner's, read and queued inside their tenant.

export interface PatternScanRow {
  id: string;
  config: PatternScanConfig;
  summary: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  candidatesTested: number | null;
  finalists: number | null;
  verified: number | null;
  effective: Record<string, unknown> | null;
  error: string | null;
  seconds: number | null;
  createdAt: Date;
  finishedAt: Date | null;
}

const scanRow = (r: typeof patternScans.$inferSelect): PatternScanRow => ({
  id: r.id,
  config: r.config as PatternScanConfig,
  summary: r.summary,
  status: r.status as PatternScanRow['status'],
  candidatesTested: r.candidatesTested,
  finalists: r.finalists,
  verified: r.verified,
  effective: (r.effective as Record<string, unknown> | null) ?? null,
  error: r.error,
  seconds: r.seconds,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
});

export async function queuePatternScan(
  tx: Transaction,
  userId: string,
  config: PatternScanConfig,
  summary: string,
): Promise<string> {
  const [row] = await tx
    .insert(patternScans)
    .values({ userId, config, summary })
    .returning({ id: patternScans.id });
  return (row as { id: string }).id;
}

export async function listPatternScans(tx: Transaction, limit = 50): Promise<PatternScanRow[]> {
  const rows = await tx
    .select()
    .from(patternScans)
    .orderBy(desc(patternScans.createdAt))
    .limit(limit);
  return rows.map(scanRow);
}

export async function getPatternScan(
  tx: Transaction,
  id: string,
): Promise<PatternScanRow | undefined> {
  const [row] = await tx.select().from(patternScans).where(eq(patternScans.id, id));
  return row ? scanRow(row) : undefined;
}

export interface PatternRow {
  id: string;
  scanId: string;
  rank: number;
  rule: PatternAtom[];
  stats: PatternStats;
  status: 'candidate' | 'verified';
  decayState: 'holding' | 'weakening' | 'broken' | null;
  decayStats: Record<string, unknown> | null;
  lastScored: string | null;
  promotedTheoryId: string | null;
  promotedStatus: string | null;
}

const patternRow = (r: typeof patterns.$inferSelect): PatternRow => ({
  id: r.id,
  scanId: r.scanId,
  rank: r.rank,
  rule: r.rule as PatternAtom[],
  stats: r.stats as PatternStats,
  status: r.status as PatternRow['status'],
  decayState: (r.decayState as PatternRow['decayState']) ?? null,
  decayStats: (r.decayStats as Record<string, unknown> | null) ?? null,
  lastScored: r.lastScored,
  promotedTheoryId: r.promotedTheoryId,
  promotedStatus: r.promotedStatus,
});

export async function listPatterns(tx: Transaction, scanId: string): Promise<PatternRow[]> {
  const rows = await tx
    .select()
    .from(patterns)
    .where(eq(patterns.scanId, scanId))
    .orderBy(asc(patterns.rank));
  return rows.map(patternRow);
}

export async function getPattern(tx: Transaction, id: string): Promise<PatternRow | undefined> {
  const [row] = await tx.select().from(patterns).where(eq(patterns.id, id));
  return row ? patternRow(row) : undefined;
}

export interface PatternOccurrenceRow {
  instrumentId: string;
  symbol: string;
  asOf: string;
  window: 'discovery' | 'holdout' | 'fresh';
  hit: boolean;
  maxRunup: number;
  maxDrawdown: number;
  forwardReturn: number;
}

export async function listPatternOccurrences(
  tx: Transaction,
  patternId: string,
): Promise<PatternOccurrenceRow[]> {
  const rows = await tx
    .select({
      instrumentId: patternOccurrences.instrumentId,
      symbol: instruments.symbol,
      asOf: patternOccurrences.asOf,
      window: patternOccurrences.window,
      hit: patternOccurrences.hit,
      maxRunup: patternOccurrences.maxRunup,
      maxDrawdown: patternOccurrences.maxDrawdown,
      forwardReturn: patternOccurrences.forwardReturn,
    })
    .from(patternOccurrences)
    .innerJoin(instruments, eq(instruments.id, patternOccurrences.instrumentId))
    .where(eq(patternOccurrences.patternId, patternId))
    .orderBy(desc(patternOccurrences.asOf), asc(instruments.symbol));
  return rows.map((r) => ({ ...r, window: r.window as PatternOccurrenceRow['window'] }));
}

/**
 * Each occurrence's daily returns from `before` trading days earlier to
 * `after` later, from the factor store's bar ratios (the event study, §8).
 * Offsets count the instrument's own snapshot rows, which are trading days.
 */
export async function patternEventPaths(
  tx: Transaction,
  patternId: string,
  window: 'discovery' | 'holdout' | 'fresh',
  before: number,
  after: number,
): Promise<EventPath[]> {
  // Calendar slack: weekends and holidays, about 1.6 calendar days per trading day.
  const back = Math.ceil(before * 1.6) + 6;
  const ahead = Math.ceil(after * 1.6) + 6;
  const rows = await tx.execute<{ occ: string; inst: string; day: string; r: number | null }>(sql`
    select o.as_of::text as occ, o.instrument_id::text as inst, s.as_of::text as day, s.close_ret as r
    from pattern_occurrence o
    join factor_snapshot s on s.instrument_id = o.instrument_id
      and s.as_of between o.as_of - ${back}::int and o.as_of + ${ahead}::int
    where o.pattern_id = ${patternId} and o."window" = ${window}
    order by o.instrument_id, o.as_of, s.as_of`);
  const byOcc = new Map<string, { occ: string; days: { day: string; r: number | null }[] }>();
  for (const row of rows) {
    const k = `${row.inst}|${row.occ}`;
    const entry = byOcc.get(k) ?? { occ: row.occ, days: [] };
    entry.days.push({ day: row.day, r: row.r === null ? null : Number(row.r) });
    byOcc.set(k, entry);
  }
  const out: EventPath[] = [];
  for (const { occ, days } of byOcc.values()) {
    const at = days.findIndex((d) => d.day === occ);
    if (at < 0) continue;
    const returns = new Map<number, number>();
    for (let k = -before + 1; k <= after; k++) {
      const d = days[at + k];
      if (d && d.r !== null) returns.set(k, d.r);
    }
    out.push({ returns });
  }
  return out;
}

const pctText = (v: number) => `${(v * 100).toFixed(1)}%`;

function windowLine(label: string, w: PatternStats['discovery']): string {
  return `- ${label}: ${hitRateWords(w)} hit; base rate ${pctText(w.baseRate)}; lift ${w.lift.toFixed(2)}; Wilson 95% lower bound ${pctText(w.wilsonLower)}${w.pValue !== null && w.pValue !== undefined ? `; one-sided binomial p ${w.pValue.toPrecision(2)}` : ''}.`;
}

/**
 * Promotes a pattern into the Theory Library (brief §9): one theory with
 * maturity Researched, the rule and both windows' evidence in its long
 * description, linked from the pattern. No strategy is created (theories and
 * strategies are separate objects; ADR 0072). Promoting twice is refused.
 */
export async function promotePattern(
  tx: Transaction,
  userId: string,
  pattern: PatternRow,
  scan: PatternScanRow,
): Promise<{ id: string; registrationNumber: string }> {
  if (pattern.promotedTheoryId)
    throw new LibraryError('conflict', 'This pattern is already in the Theory Library.');
  const cfg = scan.config;
  const outcome = outcomeWords(cfg.outcome);
  const status = pattern.status === 'verified' ? 'Verified' : 'Candidate';
  const effective = (scan.effective ?? {}) as Record<string, unknown>;
  const h = pattern.stats.holdout;
  const scanned = scan.finishedAt ?? scan.createdAt;
  const years = (() => {
    const from = Date.parse(String(effective.holdoutStart ?? ''));
    const to = Date.parse(String(effective.to ?? ''));
    return Number.isFinite(from) && Number.isFinite(to) && to > from
      ? (to - from) / (365.25 * 86_400_000)
      : 0;
  })();
  const perYear = years > 0 ? Math.max(1, Math.round(h.n / years)) : 1;
  const long = [
    `${ruleWords(pattern.rule)}, the stock ${outcome}.`,
    '',
    `Status when promoted: ${status} (pattern discovery, ${VERIFY.fdrQ * 100}% false-discovery gate on the holdout).`,
    '',
    'Evidence:',
    windowLine(
      `Holdout (${String(effective.holdoutStart ?? '?')} to ${String(effective.to ?? '?')})`,
      h,
    ),
    windowLine(
      `Discovery (${String(effective.from ?? '?')} to ${String(effective.discoveryEnd ?? '?')}, where the rule was found)`,
      pattern.stats.discovery,
    ),
    '',
    `Scan: ${scan.summary} Run ${scanned.toISOString().slice(0, 10)}; it tested ${scan.candidatesTested ?? '?'} rules, so most patterns like this are luck: the holdout figures are the evidence.`,
    `Factors: ${cfg.categories.map((c) => FACTOR_CATEGORY_LABELS[c]).join(', ')}, point in time as of each close.`,
    "Universe: today's members, so survivorship bias applies.",
  ].join('\n');
  const short = `${status} pattern: ${hitRateWords(h)} holdout occurrences, the stock ${outcome} (base ${pctText(h.baseRate)}).`;
  const entry = await registerLibraryEntry(tx, userId, {
    recordTypeCode: 'T',
    timeframeCode: 'D',
    assetClassCode: 'S',
    name: promotedName(pattern.rule),
    category: 'multi_factor',
    tags: ['pattern discovery', status.toLowerCase()],
    shortDescription: short.length <= 280 ? short : `${short.slice(0, 279)}…`,
    longDescription: long,
    assets: `US stocks: ${universeLabel(cfg.universe)}`,
    entry: `${ruleWords(pattern.rule)} at a day's close.`,
    exit: `Outcome window: ${cfg.outcome.horizon} trading days; target ${cfg.outcome.direction === 'spike' ? '+' : '−'}${cfg.outcome.pct}% from that close.`,
    frequency: { kind: 'per', value: perYear, unit: 'years' },
    turnaround: { kind: 'every', value: cfg.outcome.horizon, unit: 'days' },
    direction: cfg.outcome.direction === 'spike' ? 'long_only' : 'short_only',
    maturity: 'researched',
    dataNeeds: [
      'daily_bars',
      ...(cfg.categories.includes('fundamentals') ? (['fundamentals'] as const) : []),
      ...(cfg.categories.includes('options') ? (['options_chains'] as const) : []),
      ...(cfg.categories.includes('session') ? (['intraday_bars'] as const) : []),
    ],
    universe: {
      kind: cfg.universe.kind === 'options' ? 'list' : 'index_members',
      detail: universeLabel(cfg.universe),
    },
  });
  await tx
    .update(patterns)
    .set({ promotedTheoryId: entry.id, promotedStatus: pattern.status, promotedAt: new Date() })
    .where(eq(patterns.id, pattern.id));
  return { id: entry.id, registrationNumber: entry.registrationNumber };
}

/** Asks the miner to re-verify a pattern on all data after its discovery window (brief §10). */
export async function requestReverify(tx: Transaction, patternId: string): Promise<void> {
  await tx
    .update(patterns)
    .set({
      decayStats: sql`coalesce(${patterns.decayStats}, '{}'::jsonb) || jsonb_build_object('reverifyRequestedAt', now())`,
    })
    .where(eq(patterns.id, patternId));
}

/** The registration number of the theory a pattern was promoted to, for the link (brief §9). */
export async function theoryNumberById(tx: Transaction, theoryId: string): Promise<string | null> {
  const [row] = await tx
    .select({ number: strategyLibraryEntries.registrationNumber })
    .from(strategyLibraryEntries)
    .where(eq(strategyLibraryEntries.id, theoryId));
  return row?.number ?? null;
}
