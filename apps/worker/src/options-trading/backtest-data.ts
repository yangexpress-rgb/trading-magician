import {
  optionDailyBars,
  simulate,
  type BacktestResult,
  type LoadedData,
  type OptionsBacktestData,
  type SimulationInput,
} from '@tm/backtest';
import {
  addDays,
  isOptionLeg,
  OPTIONS_DEFAULTS,
  optionsSettings,
  optionsTradingEnabled,
  regularSession,
  UnsupportedBarRequestError,
  type Bar,
  type ContractListEntry,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';

/**
 * Options back tests in the worker (options brief v0.2 §11, ADR 0123): the
 * contract list of each underlying, active and expired, and the daily trade
 * bars of the contracts the strategy actually picks. Picks need bars to be
 * judged point in time, so the run goes in passes: simulate, fetch the bars
 * of the contracts it asked for, simulate again, at most `MAX_PASSES` times.
 */

export interface OptionsHistory {
  contracts(q: {
    underlying: string;
    expirationGte: string;
    expirationLte: string;
    strikeGte?: number;
    strikeLte?: number;
  }): Promise<{ symbol: string; expiry: string; right: 'call' | 'put'; strike: number }[]>;
  bars(
    symbols: readonly string[],
    from: string,
    to: string,
  ): Promise<Map<string, { t: string; o: number; h: number; l: number; c: number; v: number }[]>>;
}

/** Alpaca's option bars begin in February 2024 (options data brief v2 §5.2). */
export const OPTION_BARS_FROM = '2024-02-01';
export const MAX_PASSES = 5;

/** Why an options strategy can't be back tested with these inputs, or undefined. */
export function optionsBacktestProblem(
  def: StrategyDefinition,
  inputs: { interval: string; from: string },
  history: OptionsHistory | undefined,
): string | undefined {
  if (!optionsTradingEnabled()) return 'Options trading is turned off on this server';
  if (inputs.interval !== '1d')
    return 'Options back tests run on daily bars: Alpaca keeps contract bars by the day';
  if (inputs.from < OPTION_BARS_FROM)
    return `Options back tests start on or after ${OPTION_BARS_FROM}, when Alpaca's contract bars begin`;
  if (!history) return 'This worker has no Alpaca key for options history';
  return undefined;
}

export const hasOptionLegs = (def: StrategyDefinition) =>
  [...def.entry.orders, ...def.exit.orders].some((o) => isOptionLeg(o));

/** The OCC root a standard contract of `underlying` carries (§5.3); adjusted ones differ. */
const standardRoot = (symbol: string, underlying: string) =>
  symbol.startsWith(underlying) && /^\d{6}[CP]\d{8}$/.test(symbol.slice(underlying.length));

/** Each underlying's contracts over the run, wide enough for every leg's targets. */
export async function loadContractLists(
  def: StrategyDefinition,
  instruments: ReadonlyMap<string, { symbol: string }>,
  data: LoadedData,
  inputs: { from: string; to: string },
  history: OptionsHistory,
): Promise<Map<string, ContractListEntry[]>> {
  const out = new Map<string, ContractListEntry[]>();
  const legs = [...def.entry.orders, ...def.exit.orders].filter((o) => isOptionLeg(o));
  for (const id of new Set(legs.map((o) => o.instrumentId))) {
    const symbol = instruments.get(id)?.symbol;
    if (!symbol) continue;
    const specs = legs.flatMap((o) => (o.instrumentId === id && o.option ? [o.option] : []));
    const target = Math.max(...specs.map((o) => o.expiryRule.targetDte));
    const pct = Math.max(
      ...specs.map((o) => (o.strikeRule.type === 'atm' ? 0 : Math.abs(o.strikeRule.pct))),
    );
    let lo: Decimal | undefined;
    let hi: Decimal | undefined;
    for (const [key, bars] of data.series) {
      if (!key.startsWith(`${id}|`)) continue;
      for (const b of bars) {
        lo = !lo || b.low.lt(lo) ? b.low : lo;
        hi = !hi || b.high.gt(hi) ? b.high : hi;
      }
    }
    if (!lo || !hi) continue;
    const band = new Decimal(pct + 25).div(100);
    const listed = await history.contracts({
      underlying: symbol,
      expirationGte: inputs.from,
      expirationLte: addDays(inputs.to, Math.min(730, Math.max(target * 2, target + 30))),
      strikeGte: Math.floor(lo.times(new Decimal(1).minus(band)).toNumber()),
      strikeLte: Math.ceil(hi.times(band.plus(1)).toNumber()),
    });
    out.set(
      id,
      listed.map((c) => ({
        symbol: c.symbol,
        expiry: c.expiry,
        right: c.right,
        strike: String(c.strike),
        multiplier: String(OPTIONS_DEFAULTS.standardMultiplier),
        standard: standardRoot(c.symbol, symbol),
      })),
    );
  }
  return out;
}

/**
 * Runs the simulation in passes until every contract it picks has its bars
 * (or `MAX_PASSES` is reached, which the result's warnings say).
 */
export async function simulateWithOptions(
  input: Omit<SimulationInput, 'optionsData' | 'onOptionBarsNeeded'>,
  contracts: Map<string, ContractListEntry[]>,
  history: OptionsHistory,
): Promise<BacktestResult> {
  const bars = new Map<string, Bar[]>();
  const sessionOf = (d: string) => regularSession(d);
  const settings = optionsSettings();
  let result: BacktestResult | undefined;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const needed = new Set<string>();
    result = simulate({
      ...input,
      optionsData: { contracts, bars, slippagePct: settings.fillSlippagePct },
      onOptionBarsNeeded: (s) => s.forEach((x) => needed.add(x)),
    } satisfies SimulationInput & { optionsData: OptionsBacktestData });
    const missing = [...needed].filter((s) => !bars.has(s));
    if (missing.length === 0) return result;
    const got = await history.bars(missing, addDays(input.inputs.from, -7), input.inputs.to);
    for (const s of missing) bars.set(s, optionDailyBars(got.get(s) ?? [], sessionOf));
  }
  if (!result) throw new UnsupportedBarRequestError('The options back test did not run');
  result.warnings.push({
    code: 'options_passes',
    message: `Contract bars were still being found after ${MAX_PASSES} passes; some options entries were skipped`,
    count: 1,
  });
  return result;
}
