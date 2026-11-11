import {
  allOrders,
  addDays,
  BrokerUnavailableError,
  CONTEXT_INSTRUMENT_ID,
  contextInstruments,
  definitionSeries,
  getIndicator,
  isIndicatorOnlyClass,
  referencedInstruments,
  resolveIndicatorParams,
  scheduleBarMinutes,
  riskSeries,
  type Bar,
  type BarInterval,
  type FundamentalObservation,
  type HistoricalDataProvider,
  type IndicatorExpr,
  type MarketExpr,
  type EventData,
  type OptionSignal,
  type PriceAdjustment,
  type Session,
  type StrategyDefinition,
  UnsupportedBarRequestError,
} from '@tm/domain';
import type { BacktestInputs, BacktestInterval } from './inputs';

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
  /** End-of-day options signals by underlying id (options brief v2 §5.3), when the strategy reads any. */
  options?: Map<string, OptionSignal[]>;
  /** Earnings, deals and rates (free data feeds brief v1 §6), when the strategy reads any. */
  events?: EventData;
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

/**
 * Bars for one instrument could not be loaded. The message names the symbol
 * and, for the errors whose text is meant for people (feed unreachable or
 * throttled, a feed's own refusal), why; it never carries a key.
 */
export class BarLoadError extends Error {
  constructor(
    readonly symbol: string,
    cause: unknown,
  ) {
    super(`Bars for ${symbol} could not be loaded: ${reasonOf(cause)}`);
    this.name = 'BarLoadError';
  }
}

/** Errors whose messages are written for people and never hold a secret. */
const PEOPLE_FACING = new Set([
  'AlpacaUnavailableError',
  'AlpacaRateLimitError',
  'AlpacaAuthError',
  'AlpacaRequestError',
  'CustomFetchError',
]);

function reasonOf(error: unknown): string {
  if (error instanceof BrokerUnavailableError || error instanceof UnsupportedBarRequestError)
    return error.message;
  if (error instanceof Error && PEOPLE_FACING.has(error.name)) return error.message;
  return 'the data feed failed unexpectedly';
}

/** Fetches every planned series from the provider. */
export async function loadData(
  provider: HistoricalDataProvider,
  plans: readonly SeriesPlan[],
  instruments: ReadonlyMap<string, InstrumentRef>,
  /** Called after each series, e.g. to keep a queue lease while hundreds load. */
  onProgress?: () => Promise<void>,
  /**
   * Instruments that may be left out when their bars fail, such as a
   * Selection group's members: the run goes on without them and says so.
   * Any other instrument's failure stops the run, naming it.
   */
  optional: ReadonlySet<string> = new Set(),
): Promise<LoadedData> {
  const series = new Map<string, Bar[]>();
  const versions = new Set<string>();
  const warnings = new Set<string>();
  const leftOut = new Map<string, string>();
  for (const plan of plans) {
    const instrument = instruments.get(plan.spec.instrumentId);
    if (!instrument) throw new Error('The strategy uses an instrument that no longer exists');
    if (leftOut.has(plan.spec.instrumentId)) continue;
    let result: Awaited<ReturnType<HistoricalDataProvider['getBars']>>;
    try {
      result = await provider.getBars({
        ...plan.spec,
        symbol: instrument.symbol,
        assetClass: instrument.assetClass,
        from: plan.from,
        to: plan.to,
      });
    } catch (error) {
      if (!optional.has(plan.spec.instrumentId)) throw new BarLoadError(instrument.symbol, error);
      leftOut.set(plan.spec.instrumentId, `${instrument.symbol} (${reasonOf(error)})`);
      await onProgress?.();
      continue;
    }
    series.set(seriesKey(plan.spec), result.bars);
    versions.add(result.dataVersion);
    for (const w of result.warnings) warnings.add(`${instrument.symbol}: ${w}`);
    await onProgress?.();
  }
  if (leftOut.size > 0) {
    const list = [...leftOut.values()];
    warnings.add(
      `${list.length} ${list.length === 1 ? 'member was' : 'members were'} left out because ${list.length === 1 ? 'its' : 'their'} bars could not be loaded: ${list.slice(0, 5).join('; ')}${list.length > 5 ? '…' : ''}`.slice(
        0,
        500,
      ),
    );
  }
  return { series, dataVersions: [...versions].sort(), warnings: [...warnings] };
}

/** Minutes in each bar size, to compare them. */
const INTERVAL_MINUTES: Record<BarInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10_080,
};

/**
 * The run interval that matches the rules (N179, ADR 0063): conditions on
 * bars shorter than an hour run on 5-minute bars, on hourly or 4-hour bars
 * hourly, otherwise daily; a picked bar cadence for Entry (N184) counts as a
 * condition on bars of its size. `finest` is the shortest bar size any condition,
 * indicator or order price reads, or undefined when none reads bars.
 */
export function matchingBacktestInterval(def: StrategyDefinition): {
  interval: BacktestInterval;
  finest: BarInterval | undefined;
} {
  let finest: BarInterval | undefined;
  // "This instrument" stands for itself, so a Selection group's rules count before its universe is known.
  for (const e of seriesExprs(def, [CONTEXT_INSTRUMENT_ID])) {
    if (!finest || INTERVAL_MINUTES[e.interval] < INTERVAL_MINUTES[finest]) finest = e.interval;
  }
  let minutes = finest ? INTERVAL_MINUTES[finest] : INTERVAL_MINUTES['1d'];
  // A picked bar cadence for Entry asks for bars at least that fine (N184).
  // Checks after the open (N226) ask for bars as fine as that first bar.
  const cadence = scheduleBarMinutes(def.entry.schedule);
  if (cadence !== undefined) minutes = Math.min(minutes, cadence);
  // So does a picked bar cadence for Exit (ADR 0073).
  const exitCadence = scheduleBarMinutes(def.exit.schedule);
  if (exitCadence !== undefined) minutes = Math.min(minutes, exitCadence);
  return { interval: minutes < 60 ? '5m' : minutes < 1440 ? '1h' : '1d', finest };
}

/** Whether a run interval steps more coarsely than the rules' finest bars. */
export function coarserThan(run: BacktestInterval, rules: BarInterval): boolean {
  return INTERVAL_MINUTES[run] > INTERVAL_MINUTES[rules];
}
