import {
  allOrders,
  addDays,
  CONTEXT_INSTRUMENT_ID,
  contextInstruments,
  definitionSeries,
  getIndicator,
  isIndicatorOnlyClass,
  referencedInstruments,
  resolveIndicatorParams,
  riskSeries,
  type Bar,
  type BarInterval,
  type FundamentalObservation,
  type HistoricalDataProvider,
  type IndicatorExpr,
  type MarketExpr,
  type PriceAdjustment,
  type Session,
  type StrategyDefinition,
} from '@tm/domain';
import type { BacktestInputs } from './inputs';

/** One bar series the run needs: an instrument at an interval, adjustment and session. */
export interface SeriesSpec {
  instrumentId: string;
  interval: BarInterval;
  adjustment: PriceAdjustment;
  session: Session;
}

export const seriesKey = (s: SeriesSpec) =>
  `${s.instrumentId}|${s.interval}|${s.adjustment}|${s.session}`;

export interface InstrumentRef {
  symbol: string;
  assetClass: string;
  lotSize: string;
  /** Whether the broker lends it for shorting; absent or null when unknown (v1.2 item 8). */
  shortable?: boolean | null;
}

/** Bars the engine runs on, keyed by `seriesKey`, plus where they came from. */
export interface LoadedData {
  series: Map<string, Bar[]>;
  dataVersions: string[];
  warnings: string[];
  /** Point-in-time company filings by instrument id (v1.2 item 6), when the strategy reads any. */
  fundamentals?: Map<string, FundamentalObservation[]>;
}

type SeriesExpr = MarketExpr | IndicatorExpr;

/**
 * Every series the rules read: market and indicator expressions in
 * conditions and order prices (a position value reads its interval's
 * close), what metrics and statistical functions read further back, and
 * "this instrument" expanded to every universe member or leg (v1.2).
 * `members` are a Selection group's resolved universe.
 */
export function seriesExprs(
  def: StrategyDefinition,
  members: readonly string[] = [],
): SeriesExpr[] {
  return definitionSeries(def, members);
}

/** Instruments a run trades or reads, "this instrument" resolved. */
export function strategyInstruments(
  def: StrategyDefinition,
  members: readonly string[] = [],
): string[] {
  const ids = new Set<string>([
    ...seriesExprs(def, members).map((e) => e.instrumentId),
    ...allOrders(def).map((o) => o.instrumentId),
    ...contextInstruments(def, members),
    ...referencedInstruments(def),
  ]);
  ids.delete(CONTEXT_INSTRUMENT_ID);
  return [...ids];
}

/** Bars of history an expression needs before its first value. */
function lookbackBars(e: SeriesExpr): number {
  // One extra bar so "crosses" can compare with the previous value.
  const base = e.offset + 2;
  if (e.kind === 'market') return base;
  const spec = getIndicator(e.name);
  return spec ? base + spec.lookback(resolveIndicatorParams(spec, e.params)) : base;
}

/** Calendar days that hold at least `bars` bars of an interval, with a margin for holidays. */
function warmupDays(interval: BarInterval, bars: number): number {
  const tradingDays: Record<BarInterval, number> = {
    '1m': bars / 390,
    '5m': bars / 78,
    '15m': bars / 26,
    '30m': bars / 13,
    '1h': bars / 6.5,
    '4h': bars / 2,
    '1d': bars,
    '1w': bars * 5,
  };
  return Math.ceil((tradingDays[interval] ?? bars) * 1.5) + 7;
}

export interface SeriesPlan {
  spec: SeriesSpec;
  from: string;
  to: string;
}

/**
 * The bar series a run needs: one per distinct series in the rules, plus the
 * execution series (run interval and adjustment) for every instrument used,
 * each starting early enough to warm up its indicators.
 */
export function planSeries(
  def: StrategyDefinition,
  inputs: BacktestInputs,
  members: readonly string[] = [],
  /**
   * Indicator-only instruments (indices, v1.2 item 5): read by the rules at
   * their own interval, never traded, so they need no execution series.
   */
  watchOnly: ReadonlySet<string> = new Set(),
): SeriesPlan[] {
  const plans = new Map<string, { spec: SeriesSpec; bars: number }>();
  const need = (spec: SeriesSpec, bars: number) => {
    const key = seriesKey(spec);
    const existing = plans.get(key);
    if (!existing || existing.bars < bars) plans.set(key, { spec, bars });
  };
  const instruments = new Set<string>();
  // ATR sizing and ATR stops read daily bars on the fill price basis (v1.2 item 9).
  for (const e of [...seriesExprs(def, members), ...riskSeries(def, inputs.adjustment)]) {
    instruments.add(e.instrumentId);
    need(
      {
        instrumentId: e.instrumentId,
        interval: e.interval,
        adjustment: e.adjustment,
        session: e.session,
      },
      lookbackBars(e),
    );
  }
  for (const id of strategyInstruments(def, members)) instruments.add(id);
  for (const instrumentId of instruments) {
    if (watchOnly.has(instrumentId)) continue;
    need(
      {
        instrumentId,
        interval: inputs.interval,
        adjustment: inputs.adjustment,
        session: 'regular',
      },
      2,
    );
  }
  return [...plans.values()].map(({ spec, bars }) => ({
    spec,
    from: addDays(inputs.from, -warmupDays(spec.interval, bars)),
    to: inputs.to,
  }));
}

/** Instruments of a run that can only be watched (indices, v1.2 item 5). */
export function watchOnlyInstruments(instruments: ReadonlyMap<string, InstrumentRef>): Set<string> {
  const out = new Set<string>();
  for (const [id, ref] of instruments) if (isIndicatorOnlyClass(ref.assetClass)) out.add(id);
  return out;
}

/** Fetches every planned series from the provider. */
export async function loadData(
  provider: HistoricalDataProvider,
  plans: readonly SeriesPlan[],
  instruments: ReadonlyMap<string, InstrumentRef>,
  /** Called after each series, e.g. to keep a queue lease while hundreds load. */
  onProgress?: () => Promise<void>,
): Promise<LoadedData> {
  const series = new Map<string, Bar[]>();
  const versions = new Set<string>();
  const warnings = new Set<string>();
  for (const plan of plans) {
    const instrument = instruments.get(plan.spec.instrumentId);
    if (!instrument) throw new Error('The strategy uses an instrument that no longer exists');
    const result = await provider.getBars({
      ...plan.spec,
      symbol: instrument.symbol,
      assetClass: instrument.assetClass,
      from: plan.from,
      to: plan.to,
    });
    series.set(seriesKey(plan.spec), result.bars);
    versions.add(result.dataVersion);
    for (const w of result.warnings) warnings.add(`${instrument.symbol}: ${w}`);
    await onProgress?.();
  }
  return { series, dataVersions: [...versions].sort(), warnings: [...warnings] };
}
