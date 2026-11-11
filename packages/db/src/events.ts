import {
  formatDealId,
  isSameDeal,
  laterDealStatus,
  preferredDeal,
  sameDealTarget,
  type DealConfidence,
  type DealConsideration,
  type DealSignal,
  type DealStatus,
  type EarningsSignal,
  type EarningsSource,
  type EventData,
  type RatePoint,
  type ScheduledEarnings,
} from '@tm/domain';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { withTenant } from './tenant';
import {
  dataFeedConnections,
  dealEvents,
  dealFilings,
  dealStatusHistory,
  earningsCalendar,
  earningsReleases,
  earningsSue,
  eventScanState,
  instruments,
  optionUniverse,
  ratesDaily,
} from './schema';

/**
 * Storage for earnings, deals and rates (free data feeds brief v1 §3, ADR
 * 0058). Public data kept once for every tenant: the worker writes it, the
 * app login only reads it. Rows are keyed by ticker, as EDGAR files them;
 * runs look them up through their instruments' symbols.
 */

type Db = Database | Transaction;
const toNum = (v: string | null): number | null => (v === null ? null : Number(v));
const toStr = (v: number | null | undefined): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : String(v);

// ---------------------------------------------------------------------------
// Earnings releases and SUE

export interface EarningsReleaseInput {
  symbol: string;
  cik: string;
  fiscalQuarterEnd: string;
  announcedAt: string;
  announcedDate: string;
  timeKnown: boolean;
  reportedEps: number | null;
  accession: string;
  filingUrl: string;
}

/** Stores a release unless that quarter's is already stored; whether a row was added. */
export async function saveEarningsRelease(db: Db, r: EarningsReleaseInput): Promise<boolean> {
  const rows = await db
    .insert(earningsReleases)
    .values({
      symbol: r.symbol,
      cik: r.cik,
      fiscalQuarterEnd: r.fiscalQuarterEnd,
      announcedAt: new Date(r.announcedAt),
      announcedDate: r.announcedDate,
      timeKnown: r.timeKnown,
      reportedEps: toStr(r.reportedEps),
      accession: r.accession,
      filingUrl: r.filingUrl,
    })
    .onConflictDoNothing()
    .returning({ id: earningsReleases.id });
  return rows.length > 0;
}

/** Accession numbers of a company's stored releases, to skip filings already read. */
export async function storedReleaseAccessions(db: Db, symbol: string): Promise<Set<string>> {
  const rows = await db
    .select({ a: earningsReleases.accession })
    .from(earningsReleases)
    .where(eq(earningsReleases.symbol, symbol));
  return new Set(rows.map((r) => r.a));
}

/**
 * Symbols with a stored release announced before `date`: those whose history
 * is in. A stock that joins the scan later has only its newest releases
 * (ADR 0080), so the backfill looks for stocks missing from this set.
 */
export async function symbolsWithReleasesBefore(db: Db, date: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ symbol: earningsReleases.symbol })
    .from(earningsReleases)
    .where(lt(earningsReleases.announcedDate, date));
  return new Set(rows.map((r) => r.symbol));
}

export interface StoredRelease {
  id: string;
  symbol: string;
  cik: string;
  fiscalQuarterEnd: string;
  announcedAt: Date;
  announcedDate: string;
  reportedEps: number | null;
  estimatedEps: number | null;
}

/** Releases since `sinceDate` whose quarterly EPS isn't on EDGAR yet, or whose SUE isn't worked out. */
export async function releasesAwaitingSue(db: Db, sinceDate: string): Promise<StoredRelease[]> {
  const rows = await db
    .select({
      id: earningsReleases.id,
      symbol: earningsReleases.symbol,
      cik: earningsReleases.cik,
      fiscalQuarterEnd: earningsReleases.fiscalQuarterEnd,
      announcedAt: earningsReleases.announcedAt,
      announcedDate: earningsReleases.announcedDate,
      reportedEps: earningsReleases.reportedEps,
      estimatedEps: earningsReleases.estimatedEps,
    })
    .from(earningsReleases)
    .leftJoin(
      earningsSue,
      and(
        eq(earningsSue.symbol, earningsReleases.symbol),
        eq(earningsSue.fiscalQuarterEnd, earningsReleases.fiscalQuarterEnd),
      ),
    )
    .where(and(gte(earningsReleases.announcedDate, sinceDate), isNull(earningsSue.symbol)))
    .orderBy(asc(earningsReleases.announcedAt));
  return rows.map((r) => ({
    ...r,
    reportedEps: toNum(r.reportedEps),
    estimatedEps: toNum(r.estimatedEps),
  }));
}

/** Fills a release's EPS once the quarter's 10-Q or 10-K is on EDGAR, and its surprise. */
export async function updateReleaseEps(
  db: Db,
  id: string,
  reportedEps: number,
  surprisePct: number | null,
) {
  await db
    .update(earningsReleases)
    .set({ reportedEps: String(reportedEps), surprisePct: toStr(surprisePct) })
    .where(eq(earningsReleases.id, id));
}

/** A calendar feed's consensus estimate for a release (never its date or EPS, brief D1). */
export async function setReleaseEstimate(
  db: Db,
  id: string,
  estimatedEps: number,
  provider: 'fmp' | 'finnhub',
  surprisePct: number | null,
) {
  await db
    .update(earningsReleases)
    .set({
      estimatedEps: String(estimatedEps),
      estimateSource: provider,
      surprisePct: toStr(surprisePct),
    })
    .where(eq(earningsReleases.id, id));
}

export interface SueInput {
  symbol: string;
  fiscalQuarterEnd: string;
  announcedAt: string;
  epsQ: number;
  epsQMinus4: number;
  diffSd: number | null;
  sue: number | null;
  source: EarningsSource;
}

/** Stores a release's SUE; a recorded value is never replaced by a rebuilt one. */
export async function saveSue(db: Db, s: SueInput) {
  const values = {
    symbol: s.symbol,
    fiscalQuarterEnd: s.fiscalQuarterEnd,
    announcedAt: new Date(s.announcedAt),
    epsQ: String(s.epsQ),
    epsQMinus4: String(s.epsQMinus4),
    diffSd: toStr(s.diffSd),
    sue: toStr(s.sue),
    source: s.source,
    computedAt: new Date(),
  };
  await db
    .insert(earningsSue)
    .values(values)
    .onConflictDoUpdate({
      target: [earningsSue.symbol, earningsSue.fiscalQuarterEnd],
      set: { ...values },
      setWhere: sql`${earningsSue.source} = 'rebuilt' or ${s.source} = 'recorded'`,
    });
}

/** Every stored release with its SUE, per symbol, oldest first. */
export async function loadEarningsBySymbol(
  db: Db,
  symbols: readonly string[],
): Promise<Map<string, EarningsSignal[]>> {
  const out = new Map<string, EarningsSignal[]>();
  if (symbols.length === 0) return out;
  const rows = await db
    .select({
      symbol: earningsReleases.symbol,
      fiscalQuarterEnd: earningsReleases.fiscalQuarterEnd,
      announcedAt: earningsReleases.announcedAt,
      announcedDate: earningsReleases.announcedDate,
      reportedEps: earningsReleases.reportedEps,
      surprisePct: earningsReleases.surprisePct,
      sue: earningsSue.sue,
      sueSource: earningsSue.source,
    })
    .from(earningsReleases)
    .leftJoin(
      earningsSue,
      and(
        eq(earningsSue.symbol, earningsReleases.symbol),
        eq(earningsSue.fiscalQuarterEnd, earningsReleases.fiscalQuarterEnd),
      ),
    )
    .where(inArray(earningsReleases.symbol, [...symbols]))
    .orderBy(asc(earningsReleases.announcedAt));
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({
      fiscalQuarterEnd: r.fiscalQuarterEnd,
      announcedAt: r.announcedAt.toISOString(),
      announcedDate: r.announcedDate,
      reportedEps: toNum(r.reportedEps),
      sue: toNum(r.sue),
      surprisePct: toNum(r.surprisePct),
      source: (r.sueSource as EarningsSource | null) ?? 'recorded',
    });
    out.set(r.symbol, list);
  }
  return out;
}

/** The latest releases of one symbol with their filing links, newest first, for Research. */
export async function recentReleases(db: Db, symbol: string, limit = 8) {
  const rows = await db
    .select({
      fiscalQuarterEnd: earningsReleases.fiscalQuarterEnd,
      announcedAt: earningsReleases.announcedAt,
      announcedDate: earningsReleases.announcedDate,
      timeKnown: earningsReleases.timeKnown,
      reportedEps: earningsReleases.reportedEps,
      estimatedEps: earningsReleases.estimatedEps,
      surprisePct: earningsReleases.surprisePct,
      filingUrl: earningsReleases.filingUrl,
      epsQMinus4: earningsSue.epsQMinus4,
      diffSd: earningsSue.diffSd,
      sue: earningsSue.sue,
      sueSource: earningsSue.source,
    })
    .from(earningsReleases)
    .leftJoin(
      earningsSue,
      and(
        eq(earningsSue.symbol, earningsReleases.symbol),
        eq(earningsSue.fiscalQuarterEnd, earningsReleases.fiscalQuarterEnd),
      ),
    )
    .where(eq(earningsReleases.symbol, symbol))
    .orderBy(desc(earningsReleases.announcedAt))
    .limit(limit);
  return rows.map((r) => ({
    fiscalQuarterEnd: r.fiscalQuarterEnd,
    announcedAt: r.announcedAt.toISOString(),
    announcedDate: r.announcedDate,
    timeKnown: r.timeKnown,
    reportedEps: toNum(r.reportedEps),
    estimatedEps: toNum(r.estimatedEps),
    surprisePct: toNum(r.surprisePct),
    filingUrl: r.filingUrl,
    epsQMinus4: toNum(r.epsQMinus4),
    diffSd: toNum(r.diffSd),
    sue: toNum(r.sue),
    sueSource: r.sueSource as EarningsSource | null,
  }));
}

// ---------------------------------------------------------------------------
// Earnings calendar (FMP / Finnhub free; convenience data, brief D1)

export interface CalendarRow {
  symbol: string;
  date: string;
  timeHint: 'bmo' | 'amc' | null;
  estimatedEps: number | null;
}

/** Stores a calendar fetch: new dates are first seen now, dates seen again are refreshed. */
export async function saveCalendar(
  db: Db,
  provider: 'fmp' | 'finnhub',
  rows: readonly CalendarRow[],
  now: Date,
) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db
      .insert(earningsCalendar)
      .values(
        chunk.map((r) => ({
          symbol: r.symbol,
          scheduledDate: r.date,
          provider,
          timeHint: r.timeHint,
          estimatedEps: toStr(r.estimatedEps),
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [earningsCalendar.symbol, earningsCalendar.scheduledDate],
        set: {
          provider: sql`excluded.provider`,
          timeHint: sql`excluded.time_hint`,
          estimatedEps: sql`excluded.estimated_eps`,
          lastSeenAt: sql`excluded.last_seen_at`,
        },
      });
  }
}

/** Every stored scheduled date per symbol. */
export async function loadCalendarBySymbol(
  db: Db,
  symbols: readonly string[],
): Promise<Map<string, ScheduledEarnings[]>> {
  const out = new Map<string, ScheduledEarnings[]>();
  if (symbols.length === 0) return out;
  const rows = await db
    .select()
    .from(earningsCalendar)
    .where(inArray(earningsCalendar.symbol, [...symbols]))
    .orderBy(asc(earningsCalendar.scheduledDate));
  for (const r of rows) {
    const list = out.get(r.symbol) ?? [];
    list.push({
      date: r.scheduledDate,
      firstSeenMs: r.firstSeenAt.getTime(),
      lastSeenMs: r.lastSeenAt.getTime(),
    });
    out.set(r.symbol, list);
  }
  return out;
}

/** The calendar's estimate for a release dated near `date`, if it listed one. */
export async function calendarEstimateNear(db: Db, symbol: string, date: string) {
  const [row] = await db
    .select({
      eps: earningsCalendar.estimatedEps,
      provider: earningsCalendar.provider,
      date: earningsCalendar.scheduledDate,
    })
    .from(earningsCalendar)
    .where(
      and(
        eq(earningsCalendar.symbol, symbol),
        sql`abs(${earningsCalendar.scheduledDate} - ${date}::date) <= 3`,
        sql`${earningsCalendar.estimatedEps} is not null`,
      ),
    )
    .orderBy(sql`abs(${earningsCalendar.scheduledDate} - ${date}::date)`)
    .limit(1);
  return row && row.eps !== null
    ? { eps: Number(row.eps), provider: row.provider as 'fmp' | 'finnhub', date: row.date }
    : undefined;
}

/** The next scheduled date of a symbol on or after `fromDate`, for Research. */
export async function nextScheduled(db: Db, symbol: string, fromDate: string) {
  const [row] = await db
    .select()
    .from(earningsCalendar)
    .where(and(eq(earningsCalendar.symbol, symbol), gte(earningsCalendar.scheduledDate, fromDate)))
    .orderBy(asc(earningsCalendar.scheduledDate))
    .limit(1);
  return row
    ? {
        date: row.scheduledDate,
        timeHint: row.timeHint,
        provider: row.provider,
        estimatedEps: toNum(row.estimatedEps),
      }
    : null;
}

// ---------------------------------------------------------------------------
// Deals

export interface DealInput {
  targetSymbol: string | null;
  targetCik: string | null;
  targetName: string;
  acquirerName: string | null;
  announcedDate: string;
  announcedAt: string;
  offerPrice: number | null;
  consideration: DealConsideration;
  sourceFilingUrl: string;
  accession: string;
  confidence: DealConfidence;
  parseNote: string | null;
  source: 'rebuilt' | 'recorded';
  status?: DealStatus;
}

export interface DealRow extends Omit<DealInput, 'status'> {
  dealId: string;
  status: DealStatus;
  lastUpdated: string;
  checkedAt: string | null;
  /** The target's latest daily close from Alpaca bars (N151), and its date. */
  lastClose: number | null;
  lastCloseDate: string | null;
}

/** A deal row not merged into another (N152): the rows every list and run reads. */
const kept = isNull(dealEvents.mergedInto);

/** Whether a filing is already read: a deal's first filing or one linked to it later (N152). */
export async function dealAccessionKnown(db: Db, accession: string): Promise<boolean> {
  const [first] = await db
    .select({ id: dealEvents.dealId })
    .from(dealEvents)
    .where(eq(dealEvents.accession, accession))
    .limit(1);
  if (first) return true;
  const [linked] = await db
    .select({ id: dealFilings.dealId })
    .from(dealFilings)
    .where(eq(dealFilings.accession, accession))
    .limit(1);
  return !!linked;
}

/**
 * The deal a filing belongs to: one it already announced, or a kept deal of
 * the same target (by CIK, symbol or name, N152) announced within 10 days,
 * as when the target and the acquirer both file the same agreement.
 */
export async function findDeal(
  db: Db,
  q: {
    accession: string;
    targetCik: string | null;
    targetSymbol?: string | null;
    targetName: string;
    date: string;
  },
): Promise<DealRow | undefined> {
  const [byAccession] = await db
    .select()
    .from(dealEvents)
    .where(eq(dealEvents.accession, q.accession))
    .limit(1);
  if (byAccession) {
    if (!byAccession.mergedInto) return dealRow(byAccession);
    const [into] = await db
      .select()
      .from(dealEvents)
      .where(eq(dealEvents.dealId, byAccession.mergedInto));
    return into ? dealRow(into) : undefined;
  }
  const near = await db
    .select()
    .from(dealEvents)
    .where(and(kept, sql`abs(${dealEvents.announcedDate} - ${q.date}::date) <= 10`))
    .orderBy(asc(dealEvents.seq));
  const me = {
    targetCik: q.targetCik,
    targetSymbol: q.targetSymbol ?? null,
    targetName: q.targetName,
    announcedDate: q.date,
    offerPrice: null,
  };
  return near.map(dealRow).find((r) => sameDealTarget(me, r));
}

/** Links another announcing filing to a deal (N152); nothing when the filing is already linked. */
export async function linkDealFiling(
  db: Db,
  f: {
    dealId: string;
    accession: string;
    filingUrl: string;
    filedDate: string;
    mergedFrom?: string | null;
  },
): Promise<boolean> {
  const added = await db
    .insert(dealFilings)
    .values({
      accession: f.accession,
      dealId: f.dealId,
      filingUrl: f.filingUrl,
      filedDate: f.filedDate,
      mergedFrom: f.mergedFrom ?? null,
    })
    .onConflictDoNothing()
    .returning({ accession: dealFilings.accession });
  return added.length > 0;
}

/** Every announcing filing of each deal, its first one first (N152). */
export async function listDealFilings(
  db: Db,
  deals: readonly Pick<DealRow, 'dealId' | 'accession' | 'sourceFilingUrl' | 'announcedDate'>[],
): Promise<Map<string, { accession: string; url: string; filedDate: string }[]>> {
  const out = new Map<string, { accession: string; url: string; filedDate: string }[]>();
  for (const d of deals)
    out.set(d.dealId, [
      { accession: d.accession, url: d.sourceFilingUrl, filedDate: d.announcedDate },
    ]);
  if (deals.length === 0) return out;
  const rows = await db
    .select()
    .from(dealFilings)
    .where(
      inArray(
        dealFilings.dealId,
        deals.map((d) => d.dealId),
      ),
    )
    .orderBy(asc(dealFilings.filedDate), asc(dealFilings.accession));
  for (const r of rows)
    out.get(r.dealId)?.push({ accession: r.accession, url: r.filingUrl, filedDate: r.filedDate });
  return out;
}

/**
 * Folds rows that repeat one deal into one (N152): the same target,
 * announcement date and offer price. The higher-confidence parse is kept;
 * the other row keeps its id but is hidden (`merged_into`), its filing is
 * linked to the kept deal and its status history copied there. Running it
 * again changes nothing.
 */
export async function mergeDuplicateDeals(
  db: Database,
): Promise<{ kept: string; merged: string }[]> {
  return db.transaction(async (tx) => {
    // One writer at a time, as for new deal ids.
    await tx.execute(sql`lock table ${dealEvents} in share row exclusive mode`);
    const rows = (await tx.select().from(dealEvents).where(kept).orderBy(asc(dealEvents.seq))).map(
      dealRow,
    );
    const groups: DealRow[][] = [];
    for (const r of rows) {
      const g = groups.find((x) => x.some((y) => isSameDeal(y, r)));
      if (g) g.push(r);
      else groups.push([r]);
    }
    const out: { kept: string; merged: string }[] = [];
    for (const g of groups) {
      if (g.length < 2) continue;
      const winner = g.reduce((a, b) => preferredDeal(a, b));
      let status = winner.status;
      const fill: Partial<typeof dealEvents.$inferInsert> = {};
      for (const loser of g) {
        if (loser === winner) continue;
        await tx
          .insert(dealFilings)
          .values({
            accession: loser.accession,
            dealId: winner.dealId,
            filingUrl: loser.sourceFilingUrl,
            filedDate: loser.announcedDate,
            mergedFrom: loser.dealId,
          })
          .onConflictDoNothing();
        await tx
          .update(dealFilings)
          .set({ dealId: winner.dealId })
          .where(eq(dealFilings.dealId, loser.dealId));
        await tx.execute(sql`
          insert into deal_status_history
            (deal_id, changed_at, changed_date, old_status, new_status, source_filing_url, accession)
          select ${winner.dealId}, changed_at, changed_date, old_status, new_status, source_filing_url, accession
          from deal_status_history where deal_id = ${loser.dealId}
          on conflict do nothing`);
        status = laterDealStatus(status, loser.status);
        if (!winner.targetSymbol && loser.targetSymbol) fill.targetSymbol ??= loser.targetSymbol;
        if (!winner.targetCik && loser.targetCik) fill.targetCik ??= loser.targetCik;
        if (!winner.acquirerName && loser.acquirerName) fill.acquirerName ??= loser.acquirerName;
        if (winner.lastClose === null && loser.lastClose !== null) {
          fill.lastClose ??= toStr(loser.lastClose);
          fill.lastCloseDate ??= loser.lastCloseDate;
        }
        await tx
          .update(dealEvents)
          .set({ mergedInto: winner.dealId, lastUpdated: new Date() })
          .where(
            sql`${dealEvents.dealId} = ${loser.dealId} or ${dealEvents.mergedInto} = ${loser.dealId}`,
          );
        out.push({ kept: winner.dealId, merged: loser.dealId });
      }
      await tx
        .update(dealEvents)
        .set({ ...fill, status, lastUpdated: new Date() })
        .where(eq(dealEvents.dealId, winner.dealId));
    }
    return out;
  });
}

/** Target symbols of the deals still trading on their offer, for the nightly closes (N151). */
export async function dealCloseSymbols(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: dealEvents.targetSymbol })
    .from(dealEvents)
    .where(
      and(
        kept,
        inArray(dealEvents.status, ['announced', 'pending']),
        sql`${dealEvents.targetSymbol} is not null`,
      ),
    );
  return rows.flatMap((r) => (r.symbol ? [r.symbol] : [])).sort();
}

/** Stores a target's latest daily close on its deals (N151). */
export async function saveDealClose(db: Db, symbol: string, close: number, date: string) {
  if (!(close > 0)) return;
  await db
    .update(dealEvents)
    .set({ lastClose: String(close), lastCloseDate: date })
    .where(and(kept, eq(dealEvents.targetSymbol, symbol)));
}

function dealRow(r: typeof dealEvents.$inferSelect): DealRow {
  return {
    dealId: r.dealId,
    targetSymbol: r.targetSymbol,
    targetCik: r.targetCik,
    targetName: r.targetName,
    acquirerName: r.acquirerName,
    announcedDate: r.announcedDate,
    announcedAt: r.announcedAt.toISOString(),
    offerPrice: toNum(r.offerPrice),
    consideration: r.consideration as DealConsideration,
    status: r.status as DealStatus,
    sourceFilingUrl: r.sourceFilingUrl,
    accession: r.accession,
    confidence: r.confidence as DealConfidence,
    parseNote: r.parseNote,
    source: r.source as 'rebuilt' | 'recorded',
    lastUpdated: r.lastUpdated.toISOString(),
    checkedAt: r.checkedAt?.toISOString() ?? null,
    lastClose: toNum(r.lastClose),
    lastCloseDate: r.lastCloseDate,
  };
}

/** Records a new deal with the next gapless id (D00001, …). */
export async function insertDeal(db: Database, d: DealInput): Promise<string> {
  return db.transaction(async (tx) => {
    // One writer at a time takes the next number, so ids stay gapless.
    await tx.execute(sql`lock table ${dealEvents} in share row exclusive mode`);
    const [max] = await tx
      .select({ seq: sql<number>`coalesce(max(${dealEvents.seq}), 0)::int` })
      .from(dealEvents);
    const seq = (max?.seq ?? 0) + 1;
    const dealId = formatDealId(seq);
    await tx.insert(dealEvents).values({
      dealId,
      seq,
      targetSymbol: d.targetSymbol,
      targetCik: d.targetCik,
      targetName: d.targetName,
      acquirerName: d.acquirerName,
      announcedDate: d.announcedDate,
      announcedAt: new Date(d.announcedAt),
      offerPrice: toStr(d.offerPrice),
      consideration: d.consideration,
      status: d.status ?? 'announced',
      sourceFilingUrl: d.sourceFilingUrl,
      accession: d.accession,
      confidence: d.confidence,
      parseNote: d.parseNote,
      source: d.source,
    });
    return dealId;
  });
}

/** Fills in what a later filing (the target's own 8-K, a tender offer) pins down. */
export async function improveDeal(
  db: Db,
  dealId: string,
  patch: Partial<
    Pick<
      DealInput,
      | 'targetSymbol'
      | 'targetCik'
      | 'acquirerName'
      | 'offerPrice'
      | 'consideration'
      | 'confidence'
      | 'parseNote'
    >
  >,
) {
  if (Object.keys(patch).length === 0) return;
  const { offerPrice, ...rest } = patch;
  await db
    .update(dealEvents)
    .set({
      ...rest,
      ...(offerPrice !== undefined ? { offerPrice: toStr(offerPrice) } : {}),
      lastUpdated: new Date(),
    })
    .where(eq(dealEvents.dealId, dealId));
}

/** Records a status change and its history row; nothing when the filing was already applied. */
export async function changeDealStatus(
  db: Database,
  c: {
    dealId: string;
    newStatus: DealStatus;
    changedAt: string;
    changedDate: string;
    sourceFilingUrl: string;
    accession: string;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deal] = await tx
      .select({ status: dealEvents.status })
      .from(dealEvents)
      .where(eq(dealEvents.dealId, c.dealId))
      .for('update');
    if (!deal || deal.status === c.newStatus) return false;
    // A closed or withdrawn deal is final.
    if (deal.status === 'closed' || deal.status === 'withdrawn') return false;
    const added = await tx
      .insert(dealStatusHistory)
      .values({
        dealId: c.dealId,
        changedAt: new Date(c.changedAt),
        changedDate: c.changedDate,
        oldStatus: deal.status,
        newStatus: c.newStatus,
        sourceFilingUrl: c.sourceFilingUrl,
        accession: c.accession,
      })
      .onConflictDoNothing()
      .returning({ id: dealStatusHistory.id });
    if (added.length === 0) return false;
    await tx
      .update(dealEvents)
      .set({ status: c.newStatus, lastUpdated: new Date() })
      .where(eq(dealEvents.dealId, c.dealId));
    return true;
  });
}

/** Active deals (announced or pending) with a known target, least recently checked first. */
export async function dealsToCheck(db: Db, limit = 200): Promise<DealRow[]> {
  const rows = await db
    .select()
    .from(dealEvents)
    .where(
      and(
        kept,
        inArray(dealEvents.status, ['announced', 'pending']),
        sql`${dealEvents.targetCik} is not null`,
      ),
    )
    .orderBy(sql`${dealEvents.checkedAt} asc nulls first`)
    .limit(limit);
  return rows.map(dealRow);
}

export async function markDealChecked(db: Db, dealId: string, at: Date) {
  await db.update(dealEvents).set({ checkedAt: at }).where(eq(dealEvents.dealId, dealId));
}

/** Every deal per target symbol with its status changes, for runs. */
export async function loadDealsBySymbol(
  db: Db,
  symbols: readonly string[],
): Promise<Map<string, DealSignal[]>> {
  const out = new Map<string, DealSignal[]>();
  if (symbols.length === 0) return out;
  const deals = await db
    .select()
    .from(dealEvents)
    .where(and(kept, inArray(dealEvents.targetSymbol, [...symbols])))
    .orderBy(asc(dealEvents.announcedAt));
  if (deals.length === 0) return out;
  const history = await db
    .select()
    .from(dealStatusHistory)
    .where(
      inArray(
        dealStatusHistory.dealId,
        deals.map((d) => d.dealId),
      ),
    )
    .orderBy(asc(dealStatusHistory.changedAt));
  for (const d of deals) {
    if (!d.targetSymbol) continue;
    const list = out.get(d.targetSymbol) ?? [];
    list.push({
      dealId: d.dealId,
      announcedAt: d.announcedAt.toISOString(),
      offerPrice: toNum(d.offerPrice),
      confidence: d.confidence as DealConfidence,
      changes: history
        .filter((h) => h.dealId === d.dealId)
        .map((h) => ({ date: h.changedDate, status: h.newStatus as DealStatus })),
    });
    out.set(d.targetSymbol, list);
  }
  return out;
}

/** The Deals list in Research: active deals first, newest first. */
export async function listDeals(db: Db, opts: { active?: boolean; limit?: number } = {}) {
  const rows = await db
    .select()
    .from(dealEvents)
    .where(opts.active ? and(kept, inArray(dealEvents.status, ['announced', 'pending'])) : kept)
    .orderBy(desc(dealEvents.announcedAt))
    .limit(opts.limit ?? 200);
  return rows.map(dealRow);
}

// ---------------------------------------------------------------------------
// Rates

/** Stores FRED's DTB3 days on or after `fromDate` (a fraction each); returns how many. */
export async function saveRates(
  db: Db,
  days: readonly { date: string; rate: number }[],
  fromDate: string,
): Promise<number> {
  const rows = days.filter((d) => d.date >= fromDate && Number.isFinite(d.rate));
  for (let i = 0; i < rows.length; i += 500) {
    await db
      .insert(ratesDaily)
      .values(rows.slice(i, i + 500).map((d) => ({ date: d.date, tbill3m: String(d.rate) })))
      .onConflictDoUpdate({
        target: ratesDaily.date,
        set: { tbill3m: sql`excluded.tbill_3m`, recordedAt: sql`now()` },
        setWhere: sql`${ratesDaily.tbill3m} is distinct from excluded.tbill_3m`,
      });
  }
  return rows.length;
}

export async function loadRates(db: Db, fromDate?: string): Promise<RatePoint[]> {
  const rows = await db
    .select()
    .from(ratesDaily)
    .where(fromDate ? gte(ratesDaily.date, fromDate) : sql`true`)
    .orderBy(asc(ratesDaily.date));
  return rows.map((r) => ({ date: r.date, tbill3m: Number(r.tbill3m) }));
}

// ---------------------------------------------------------------------------
// Job state

export type EventJob =
  | 'earnings_scan'
  | 'earnings_rebuild'
  | 'earnings_backfill'
  | 'deals_scan'
  | 'deals_rebuild'
  | 'calendar'
  | 'deal_closes';

export interface ScanState {
  job: EventJob;
  coveredFrom: string | null;
  coveredTo: string | null;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  note: string | null;
}

export async function getScanState(db: Db, job: EventJob): Promise<ScanState | undefined> {
  const [row] = await db.select().from(eventScanState).where(eq(eventScanState.job, job));
  return row as ScanState | undefined;
}

export async function listScanStates(db: Db): Promise<ScanState[]> {
  return (await db.select().from(eventScanState).orderBy(asc(eventScanState.job))) as ScanState[];
}

export async function setScanState(db: Db, job: EventJob, patch: Partial<Omit<ScanState, 'job'>>) {
  await db
    .insert(eventScanState)
    .values({ job, ...patch })
    .onConflictDoUpdate({ target: eventScanState.job, set: patch });
}

/** The first day the deal tracker covers: the rebuild's start once it has run, else the daily scan's. */
export async function dealsCoveredFrom(db: Db): Promise<string | undefined> {
  const rows = await db
    .select({ from: eventScanState.coveredFrom })
    .from(eventScanState)
    .where(
      and(
        inArray(eventScanState.job, ['deals_rebuild', 'deals_scan']),
        sql`${eventScanState.coveredFrom} is not null`,
        sql`${eventScanState.coveredTo} is not null`,
      ),
    )
    .orderBy(asc(eventScanState.coveredFrom))
    .limit(1);
  return rows[0]?.from ?? undefined;
}

// ---------------------------------------------------------------------------
// Universe and keys

/**
 * Stocks the earnings scan covers besides the S&P 500: every stock a saved
 * strategy uses, which joins the options universe when the strategy is saved.
 */
export async function strategyStockSymbols(db: Db): Promise<string[]> {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(optionUniverse)
    .innerJoin(instruments, eq(instruments.id, optionUniverse.underlyingId))
    .where(and(eq(optionUniverse.active, true), eq(instruments.assetClass, 'stock')));
  return rows.map((r) => r.symbol);
}

/**
 * Platform admins' active feeds of one provider, oldest admin first (the
 * key fallback of ADR 0050, extended to EDGAR and the calendar feeds).
 */
export async function adminFeedsOf(
  db: Database,
  provider: string,
): Promise<{ userId: string; feedId: string; credentialId: string }[]> {
  const admins = await db.execute<{ user_id: string }>(
    sql`select user_id from options_key_admins()`,
  );
  const out: { userId: string; feedId: string; credentialId: string }[] = [];
  for (const { user_id: userId } of admins) {
    const feeds = await withTenant(db, { userId }, (tx) =>
      tx
        .select({ id: dataFeedConnections.id, credentialRef: dataFeedConnections.credentialRef })
        .from(dataFeedConnections)
        .where(
          and(eq(dataFeedConnections.provider, provider), eq(dataFeedConnections.isActive, true)),
        )
        .orderBy(asc(dataFeedConnections.createdAt)),
    );
    const feed = feeds.find((f) => f.credentialRef);
    if (feed?.credentialRef)
      out.push({ userId, feedId: feed.id, credentialId: feed.credentialRef });
  }
  return out;
}

/** Symbols of instruments by id, for looking up symbol-keyed event rows. */
export async function instrumentSymbols(
  db: Db,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(inArray(instruments.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.symbol]));
}

/**
 * The event data a run reads (free data feeds brief v1 §6), by instrument id:
 * `reads` maps each instrument to the event metric ids read for it.
 */
export async function loadEventData(
  db: Db,
  reads: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<EventData> {
  const symbols = await instrumentSymbols(db, [...reads.keys()]);
  const want = (prefix: string) =>
    [...reads].filter(([, ms]) => [...ms].some((m) => m.startsWith(prefix))).map(([id]) => id);
  const byId = <T>(ids: string[], bySymbol: Map<string, T>) => {
    const out = new Map<string, T>();
    for (const id of ids) {
      const v = bySymbol.get(symbols.get(id) ?? '');
      if (v !== undefined) out.set(id, v);
    }
    return out;
  };
  const earningsIds = want('earnings.');
  const dealIds = want('deals.');
  const earningsSymbols = earningsIds.flatMap((id) => symbols.get(id) ?? []);
  const dealSymbols = dealIds.flatMap((id) => symbols.get(id) ?? []);
  return {
    earnings: byId(earningsIds, await loadEarningsBySymbol(db, earningsSymbols)),
    calendar: byId(earningsIds, await loadCalendarBySymbol(db, earningsSymbols)),
    deals: byId(dealIds, await loadDealsBySymbol(db, dealSymbols)),
    rates: want('rates.').length > 0 ? await loadRates(db) : [],
    dealsFrom: dealIds.length > 0 ? await dealsCoveredFrom(db) : undefined,
  };
}

/**
 * The latest underlying close the options recording stored for each symbol
 * (ADR 0047), for the Deals list to show a spread; symbols outside the
 * recorded universe are left out.
 */
export async function latestRecordedCloses(
  db: Db,
  symbols: readonly string[],
): Promise<Map<string, { close: number; date: string }>> {
  const out = new Map<string, { close: number; date: string }>();
  if (symbols.length === 0) return out;
  const rows = await db.execute<{ symbol: string; close: string; as_of_date: string }>(sql`
    select distinct on (i.symbol) i.symbol, s.underlying_close as close, s.as_of_date::text as as_of_date
    from option_daily_signal s
    join instrument i on i.id = s.underlying_id
    where i.symbol in (${sql.join(
      symbols.map((s) => sql`${s}`),
      sql`, `,
    )})
      and i.asset_class = 'stock'
      and s.underlying_close is not null
    order by i.symbol, s.as_of_date desc`);
  for (const r of rows) {
    const close = Number(r.close);
    if (Number.isFinite(close) && close > 0) out.set(r.symbol, { close, date: r.as_of_date });
  }
  return out;
}
