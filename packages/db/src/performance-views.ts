import {
  addDays,
  combineSeries,
  drawdowns,
  growthIndex,
  maxDrawdown,
  nyDate,
  sharpe,
  tradeStats,
  MIN_SHARPE_DAYS,
  type Series,
} from '@tm/domain';
import { and, eq, inArray, lte, type SQL } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { Transaction } from './client';
import { listCycleTrades, type CycleTrade } from './performance';
import {
  accountValuations,
  bookValuations,
  fills,
  instruments,
  orderIntents,
  strategies,
  strategyRuntimes,
  tradingAccounts,
} from './schema';
import type { PositionDifference } from './valuations';

/**
 * Performance views (Design v1.0 §10, §14.3; ADR 0021): summary, daily
 * series and trades for a set of filters. Series come from the stored daily
 * valuations (ADR 0020); trades from the ledger (ADR 0019). Ranges are NYSE
 * session dates, inclusive.
 */

export interface PerformanceFilter {
  from?: string | undefined;
  to?: string | undefined;
  accountIds?: readonly string[] | undefined;
  strategyIds?: readonly string[] | undefined;
  versionIds?: readonly string[] | undefined;
  instrumentIds?: readonly string[] | undefined;
  assetClasses?: readonly string[] | undefined;
  mode?: 'paper' | 'live' | undefined;
}

const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);
const money = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);
const pct = (d: Decimal) => d.times(HUNDRED).toDecimalPlaces(2).toFixed(2);

interface Scope {
  /** Nothing can match (live mode, or a filter that matches no instrument). */
  empty: boolean;
  filtered: boolean;
  accountIds?: string[] | undefined;
  runtimeIds?: string[] | undefined;
  instrumentIds?: string[] | undefined;
}

async function resolveScope(tx: Transaction, f: PerformanceFilter): Promise<Scope> {
  // Live trading does not exist yet: its view is empty, not an error.
  if (f.mode === 'live') return { empty: true, filtered: true };
  let instrumentIds = f.instrumentIds ? [...f.instrumentIds] : undefined;
  if (f.assetClasses) {
    const rows = await tx
      .select({ id: instruments.id })
      .from(instruments)
      .where(inArray(instruments.assetClass, f.assetClasses as never[]));
    const ofClass = new Set(rows.map((r) => r.id));
    instrumentIds = instrumentIds ? instrumentIds.filter((i) => ofClass.has(i)) : [...ofClass];
  }
  let runtimeIds: string[] | undefined;
  if (f.strategyIds || f.versionIds) {
    const where: SQL[] = [];
    if (f.strategyIds) where.push(inArray(strategyRuntimes.strategyId, [...f.strategyIds]));
    if (f.versionIds) where.push(inArray(strategyRuntimes.versionId, [...f.versionIds]));
    runtimeIds = (
      await tx
        .select({ id: strategyRuntimes.id })
        .from(strategyRuntimes)
        .where(and(...where))
    ).map((r) => r.id);
  }
  const accountIds = f.accountIds ? [...f.accountIds] : undefined;
  return {
    empty: instrumentIds?.length === 0 || runtimeIds?.length === 0 || accountIds?.length === 0,
    filtered: Boolean(f.strategyIds || f.versionIds || f.instrumentIds || f.assetClasses),
    accountIds,
    runtimeIds,
    instrumentIds,
  };
}

interface BookRow {
  runtimeId: string;
  accountId: string;
  instrumentId: string;
  strategyId: string;
  strategyName: string;
  symbol: string;
  assetClass: string;
  sessionDate: string;
  asOf: Date;
  realized: Decimal;
  unrealized: Decimal;
  fees: Decimal;
  costBasis: Decimal;
  marketValue: Decimal;
  markStale: boolean;
}

async function loadBooks(tx: Transaction, scope: Scope, to: string | undefined) {
  if (scope.empty) return [];
  const where: SQL[] = [];
  if (scope.accountIds) where.push(inArray(bookValuations.accountId, scope.accountIds));
  if (scope.runtimeIds) where.push(inArray(bookValuations.runtimeId, scope.runtimeIds));
  if (scope.instrumentIds) where.push(inArray(bookValuations.instrumentId, scope.instrumentIds));
  if (to) where.push(lte(bookValuations.sessionDate, to));
  const rows = await tx
    .select({
      runtimeId: bookValuations.runtimeId,
      accountId: bookValuations.accountId,
      instrumentId: bookValuations.instrumentId,
      strategyId: strategyRuntimes.strategyId,
      strategyName: strategies.name,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
      sessionDate: bookValuations.sessionDate,
      asOf: bookValuations.asOf,
      realized: bookValuations.realized,
      unrealized: bookValuations.unrealized,
      fees: bookValuations.fees,
      openFees: bookValuations.openFees,
      costBasis: bookValuations.costBasis,
      marketValue: bookValuations.marketValue,
      markStale: bookValuations.markStale,
    })
    .from(bookValuations)
    .innerJoin(strategyRuntimes, eq(strategyRuntimes.id, bookValuations.runtimeId))
    .innerJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .innerJoin(instruments, eq(instruments.id, bookValuations.instrumentId))
    .where(where.length > 0 ? and(...where) : undefined);
  return rows.map((r): BookRow => ({
    ...r,
    realized: new Decimal(r.realized),
    // Fees already paid on open lots come off what they are worth now.
    unrealized: new Decimal(r.unrealized).minus(r.openFees),
    fees: new Decimal(r.fees).plus(r.openFees),
    costBasis: new Decimal(r.costBasis).abs(),
    marketValue: new Decimal(r.marketValue).abs(),
  }));
}

async function loadAccounts(tx: Transaction, scope: Scope, to: string | undefined) {
  if (scope.empty) return [];
  const where: SQL[] = [];
  if (scope.accountIds) where.push(inArray(accountValuations.accountId, scope.accountIds));
  if (to) where.push(lte(accountValuations.sessionDate, to));
  return tx
    .select({
      accountId: accountValuations.accountId,
      accountName: tradingAccounts.nickname,
      sessionDate: accountValuations.sessionDate,
      asOf: accountValuations.asOf,
      final: accountValuations.final,
      startingEquity: accountValuations.startingEquity,
      appEquity: accountValuations.appEquity,
      brokerEquity: accountValuations.brokerEquity,
      difference: accountValuations.difference,
      positionDifferences: accountValuations.positionDifferences,
      staleMarks: accountValuations.staleMarks,
      flagged: accountValuations.flagged,
    })
    .from(accountValuations)
    .innerJoin(tradingAccounts, eq(tradingAccounts.id, accountValuations.accountId))
    .where(where.length > 0 ? and(...where) : undefined)
    .orderBy(accountValuations.sessionDate);
}

type Keyed<T> = Map<string, { rows: T[] }>;
function groupBy<T>(rows: readonly T[], key: (r: T) => string): Keyed<T> {
  const out: Keyed<T> = new Map();
  for (const r of rows) {
    const k = key(r);
    const g = out.get(k) ?? { rows: [] };
    g.rows.push(r);
    out.set(k, g);
  }
  return out;
}

const bookKey = (b: BookRow) => `${b.runtimeId}|${b.accountId}|${b.instrumentId}`;

/** Adds up a measure across books, day by day, each carried forward on days it missed. */
function bookSeries(books: readonly BookRow[], measure: (b: BookRow) => Decimal) {
  const series: Series[] = [...groupBy(books, bookKey).values()].map((g) => ({
    start: ZERO,
    points: new Map(g.rows.map((r) => [r.sessionDate, measure(r)])),
  }));
  return new Map(combineSeries(series).map((p) => [p.date, p.value]));
}

const pnlOf = (b: BookRow) => b.realized.plus(b.unrealized);

/** The value on the last date before `from` (the base a range is measured from). */
function before(series: ReadonlyMap<string, Decimal>, from: string | undefined): Decimal {
  if (!from) return ZERO;
  let base = ZERO;
  for (const [date, v] of [...series].sort(([a], [b]) => a.localeCompare(b))) {
    if (date >= from) break;
    base = v;
  }
  return base;
}

function lastIn(series: ReadonlyMap<string, Decimal>): Decimal {
  const dates = [...series.keys()].sort();
  const last = dates.at(-1);
  return last ? (series.get(last) ?? ZERO) : ZERO;
}

const inRange = (date: string, f: PerformanceFilter) =>
  (!f.from || date >= f.from) && (!f.to || date <= f.to);

/** Account equity over time, as one series with new accounts counted as money brought in. */
function equitySeries(accounts: Awaited<ReturnType<typeof loadAccounts>>) {
  const series: Series[] = [];
  const finals = new Map<string, boolean>();
  for (const g of groupBy(accounts, (a) => a.accountId).values()) {
    const valued = g.rows.filter((r) => r.appEquity !== null);
    const first = valued[0];
    if (!first) continue;
    series.push({
      start: new Decimal(first.startingEquity ?? first.appEquity ?? 0),
      points: new Map(valued.map((r) => [r.sessionDate, new Decimal(r.appEquity ?? 0)])),
    });
  }
  for (const a of accounts)
    finals.set(a.sessionDate, (finals.get(a.sessionDate) ?? true) && a.final);
  const combined = combineSeries(series);
  const index = growthIndex(combined.map((p) => ({ equity: p.value, flow: p.flow })));
  // The index leaves out days before anything was invested; line it up with the dates.
  const offset = combined.length - index.length;
  return combined.map((p, i) => ({
    ...p,
    index: i >= offset ? (index[i - offset] ?? null) : null,
    final: finals.get(p.date) ?? false,
  }));
}

export interface PerformancePoint {
  date: string;
  equity: string | null;
  pnl: string;
  drawdown: string;
  drawdownPct: string | null;
  final: boolean;
}

export async function performanceTimeseries(
  tx: Transaction,
  f: PerformanceFilter,
): Promise<{ currency: 'USD'; filtered: boolean; points: PerformancePoint[] }> {
  const scope = await resolveScope(tx, f);
  const books = await loadBooks(tx, scope, f.to);
  const pnl = bookSeries(books, pnlOf);
  const base = before(pnl, f.from);

  if (!scope.filtered) {
    const equity = equitySeries(await loadAccounts(tx, scope, f.to)).filter((p) =>
      inRange(p.date, f),
    );
    let peak = ZERO;
    let peakIndex: Decimal | null = null;
    return {
      currency: 'USD',
      filtered: false,
      points: equity.map((p) => {
        if (p.value.gt(peak)) peak = p.value;
        if (p.index && (!peakIndex || p.index.gt(peakIndex))) peakIndex = p.index;
        const dd = p.index && peakIndex ? new Decimal(1).minus(p.index.div(peakIndex)) : null;
        return {
          date: p.date,
          equity: money(p.value),
          pnl: money(carried(pnl, p.date).minus(base)),
          drawdown: money(peak.minus(p.value)),
          drawdownPct: dd ? pct(dd) : null,
          final: p.final,
        };
      }),
    };
  }

  const dates = [...pnl.keys()].sort().filter((d) => inRange(d, f));
  const values = dates.map((d) => (pnl.get(d) ?? ZERO).minus(base));
  const dd = drawdowns(values);
  const finals = new Set(
    (await loadAccounts(tx, scope, f.to)).filter((a) => a.final).map((a) => a.sessionDate),
  );
  return {
    currency: 'USD',
    filtered: true,
    points: dates.map((date, i) => ({
      date,
      equity: null,
      pnl: money(values[i] ?? ZERO),
      drawdown: money(dd[i] ?? ZERO),
      drawdownPct: null,
      final: finals.has(date),
    })),
  };
}

function carried(series: ReadonlyMap<string, Decimal>, date: string): Decimal {
  return series.get(date) ?? before(series, addDays(date, 1));
}

export async function performanceTrades(
  tx: Transaction,
  f: PerformanceFilter,
): Promise<{ currency: 'USD'; trades: CycleTrade[] }> {
  return { currency: 'USD', trades: await tradesFor(tx, f, await resolveScope(tx, f)) };
}

async function tradesFor(tx: Transaction, f: PerformanceFilter, scope: Scope) {
  if (scope.empty) return [];
  const trades = await listCycleTrades(tx, {
    accountIds: scope.accountIds,
    instrumentIds: scope.instrumentIds,
    strategyIds: f.strategyIds,
    versionIds: f.versionIds,
    mode: f.mode,
  });
  // A trade belongs to the session it closed in, or, while open, the one it opened in.
  return trades.filter((t) => inRange(nyDate(t.closedAt ?? t.openedAt), f));
}

export interface PerformanceSummary {
  currency: 'USD';
  from: string | null;
  to: string | null;
  filtered: boolean;
  equity: {
    start: string | null;
    end: string | null;
    returnPct: string | null;
    maxDrawdownPct: string | null;
    sharpe: string | null;
  };
  sessions: number;
  shortHistory: boolean;
  pnl: { net: string; gross: string; realized: string; unrealized: string; fees: string };
  peakCapital: string;
  returnOnPeakCapitalPct: string | null;
  exposure: { gross: string; pctOfEquity: string | null };
  turnover: { traded: string; pctOfEquity: string | null };
  trades: {
    count: number;
    open: number;
    closed: number;
    wins: number;
    losses: number;
    winRatePct: string | null;
    profitFactor: string | null;
    averageNet: string | null;
    averageWin: string | null;
    averageLoss: string | null;
    best: string | null;
    worst: string | null;
  };
  byStrategy: {
    strategyId: string;
    strategyName: string;
    net: string;
    closedTrades: number;
    peakCapital: string;
    returnOnPeakCapitalPct: string | null;
  }[];
  byAsset: { instrumentId: string; symbol: string; assetClass: string; net: string }[];
  dataQuality: {
    lastValuedAt: string | null;
    staleMarks: number;
    differences: {
      accountId: string;
      accountName: string;
      sessionDate: string;
      appEquity: string | null;
      brokerEquity: string | null;
      equityDifference: string | null;
      positions: PositionDifference[];
    }[];
  };
}

/** Net over the range and the most capital at work, for a set of books. */
function bookTotals(books: readonly BookRow[], f: PerformanceFilter) {
  const measure = (m: (b: BookRow) => Decimal) => {
    const s = bookSeries(books, m);
    const sliced = new Map([...s].filter(([d]) => !f.to || d <= f.to));
    return lastIn(sliced).minus(before(s, f.from));
  };
  const capital = bookSeries(books, (b) => b.costBasis);
  const peak = [...capital]
    .filter(([d]) => inRange(d, f))
    .reduce((m, [, v]) => Decimal.max(m, v), ZERO);
  return {
    net: measure(pnlOf),
    realized: measure((b) => b.realized),
    unrealized: measure((b) => b.unrealized),
    fees: measure((b) => b.fees),
    peak,
  };
}

/** The value of every fill in scope and range: quantity times price times multiplier. */
async function tradedNotional(tx: Transaction, f: PerformanceFilter, scope: Scope) {
  if (scope.empty) return ZERO;
  const where: SQL[] = [];
  if (scope.accountIds) where.push(inArray(orderIntents.accountId, scope.accountIds));
  if (scope.runtimeIds) where.push(inArray(orderIntents.runtimeId, scope.runtimeIds));
  if (scope.instrumentIds) where.push(inArray(orderIntents.instrumentId, scope.instrumentIds));
  const rows = await tx
    .select({
      quantity: fills.quantity,
      price: fills.price,
      multiplier: instruments.multiplier,
      filledAt: fills.filledAt,
    })
    .from(fills)
    .innerJoin(orderIntents, eq(orderIntents.id, fills.intentId))
    .innerJoin(instruments, eq(instruments.id, orderIntents.instrumentId))
    .where(where.length > 0 ? and(...where) : undefined);
  return rows
    .filter((r) => inRange(nyDate(r.filledAt), f))
    .reduce((a, r) => a.plus(new Decimal(r.quantity).times(r.price).times(r.multiplier)), ZERO);
}

const returnOn = (net: Decimal, capital: Decimal) => (capital.gt(0) ? pct(net.div(capital)) : null);

export async function performanceSummary(
  tx: Transaction,
  f: PerformanceFilter,
): Promise<PerformanceSummary> {
  const scope = await resolveScope(tx, f);
  const books = await loadBooks(tx, scope, f.to);
  const accounts = await loadAccounts(tx, scope, f.to);
  const trades = await tradesFor(tx, f, scope);
  const closed = trades.filter((t) => t.closedAt !== null);
  const totals = bookTotals(books, f);
  const capitalOf = (ts: readonly CycleTrade[]) =>
    ts.reduce((m, t) => Decimal.max(m, new Decimal(t.capital)), ZERO);
  const peakCapital = Decimal.max(totals.peak, capitalOf(trades));

  // Account equity, measured on the growth index so new accounts are not gains.
  let equity: PerformanceSummary['equity'] = {
    start: null,
    end: null,
    returnPct: null,
    maxDrawdownPct: null,
    sharpe: null,
  };
  const series = equitySeries(accounts);
  const ranged = series.filter((p) => inRange(p.date, f));
  if (!scope.filtered && ranged.length > 0) {
    const from = f.from;
    const prior = from ? series.filter((p) => p.date < from).at(-1) : undefined;
    const closes = ranged.flatMap((p) => (p.index ? [p.index] : []));
    const baseIndex = prior?.index ?? new Decimal(1);
    const startEquity = prior ? prior.value : (ranged[0]?.flow ?? ZERO);
    const end = ranged[ranged.length - 1] as (typeof ranged)[number];
    const s = sharpe(closes, baseIndex);
    equity = {
      start: money(startEquity),
      end: money(end.value),
      returnPct: end.index ? pct(end.index.div(baseIndex).minus(1)) : null,
      maxDrawdownPct: closes.length > 0 ? pct(maxDrawdown(closes, baseIndex)) : null,
      sharpe: s ? s.toDecimalPlaces(2).toFixed(2) : null,
    };
  }
  // Exposure: what is held at the last session in range. Turnover: what was traded in it.
  const exposureSeries = bookSeries(books, (b) => b.marketValue);
  const grossExposure = lastIn(new Map([...exposureSeries].filter(([d]) => inRange(d, f))));
  const traded = await tradedNotional(tx, f, scope);
  const endEquity = scope.filtered || ranged.length === 0 ? null : (ranged.at(-1)?.value ?? null);
  const averageEquity =
    scope.filtered || ranged.length === 0
      ? null
      : ranged.reduce((a, p) => a.plus(p.value), ZERO).div(ranged.length);

  const sessions = new Set(
    (scope.filtered ? books.map((b) => b.sessionDate) : accounts.map((a) => a.sessionDate)).filter(
      (d) => inRange(d, f),
    ),
  ).size;

  const stats = tradeStats(closed.map((t) => new Decimal(t.net)));
  const byStrategy = [...groupBy(books, (b) => b.strategyId).entries()].map(([id, g]) => {
    const t = bookTotals(g.rows, f);
    const own = trades.filter((tr) => tr.strategyId === id);
    const peak = Decimal.max(t.peak, capitalOf(own));
    return {
      strategyId: id,
      strategyName: g.rows[0]?.strategyName ?? '',
      net: money(t.net),
      closedTrades: own.filter((tr) => tr.closedAt !== null).length,
      peakCapital: money(peak),
      returnOnPeakCapitalPct: returnOn(t.net, peak),
    };
  });
  const byAsset = [...groupBy(books, (b) => b.instrumentId).entries()].map(([id, g]) => ({
    instrumentId: id,
    symbol: g.rows[0]?.symbol ?? '?',
    assetClass: g.rows[0]?.assetClass ?? '',
    net: money(bookTotals(g.rows, f).net),
  }));

  // Data quality: the latest valuation of each account in range, and every flagged close.
  const inScope = accounts.filter((a) => inRange(a.sessionDate, f));
  const latest = [...groupBy(inScope, (a) => a.accountId).values()].flatMap((g) =>
    g.rows.slice(-1),
  );
  const lastValuedAt = latest.reduce<Date | null>((m, a) => (!m || a.asOf > m ? a.asOf : m), null);
  const differences = inScope
    .filter((a) => a.flagged)
    .reverse()
    .map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName,
      sessionDate: a.sessionDate,
      appEquity: a.appEquity === null ? null : money(new Decimal(a.appEquity)),
      brokerEquity: a.brokerEquity === null ? null : money(new Decimal(a.brokerEquity)),
      equityDifference: a.difference === null ? null : money(new Decimal(a.difference)),
      positions: a.positionDifferences as PositionDifference[],
    }));

  return {
    currency: 'USD',
    from: f.from ?? null,
    to: f.to ?? null,
    filtered: scope.filtered,
    equity,
    sessions,
    shortHistory: sessions < MIN_SHARPE_DAYS,
    pnl: {
      net: money(totals.net),
      gross: money(totals.net.plus(totals.fees)),
      realized: money(totals.realized),
      unrealized: money(totals.unrealized),
      fees: money(totals.fees),
    },
    peakCapital: money(peakCapital),
    returnOnPeakCapitalPct: returnOn(totals.net, peakCapital),
    exposure: {
      gross: money(grossExposure),
      pctOfEquity: endEquity?.gt(0) ? pct(grossExposure.div(endEquity)) : null,
    },
    turnover: {
      traded: money(traded),
      pctOfEquity: averageEquity?.gt(0) ? pct(traded.div(averageEquity)) : null,
    },
    trades: {
      count: trades.length,
      open: trades.length - closed.length,
      closed: closed.length,
      wins: stats.wins,
      losses: stats.losses,
      winRatePct: stats.winRate ? pct(stats.winRate) : null,
      profitFactor: stats.profitFactor ? stats.profitFactor.toDecimalPlaces(2).toFixed(2) : null,
      averageNet: stats.averageNet ? money(stats.averageNet) : null,
      averageWin: stats.averageWin ? money(stats.averageWin) : null,
      averageLoss: stats.averageLoss ? money(stats.averageLoss) : null,
      best: stats.best ? money(stats.best) : null,
      worst: stats.worst ? money(stats.worst) : null,
    },
    byStrategy: byStrategy.sort((a, b) => new Decimal(b.net).cmp(a.net)),
    byAsset: byAsset.sort((a, b) => new Decimal(b.net).cmp(a.net)),
    dataQuality: {
      lastValuedAt: lastValuedAt?.toISOString() ?? null,
      staleMarks: latest.reduce((n, a) => n + a.staleMarks, 0),
      differences,
    },
  };
}
