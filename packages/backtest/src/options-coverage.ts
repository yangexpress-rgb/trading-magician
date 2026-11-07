import { nyDate, signalAt, type OptionSignal } from '@tm/domain';

/**
 * How a run's bars were covered by end-of-day options signals (options data
 * brief v2 §5.3): a run entirely before an underlying's first signal fails,
 * naming it and the first date; otherwise the summary says how many bars had
 * options data and how many of those read the approximate rebuilt history.
 */

export interface OptionsCoverage {
  instrumentId: string;
  symbol: string;
  bars: number;
  withData: number;
  rebuilt: number;
}

/** The message for a run whose dates are all before an underlying's first signal, or undefined. */
export function optionsBeforeFirstDate(
  symbol: string,
  signals: readonly OptionSignal[] | undefined,
  to: string,
): string | undefined {
  const first = signals?.[0]?.asOfDate;
  if (!first)
    return `No options data for ${symbol} yet: the recording starts with the next session`;
  return first > to ? `No options data for ${symbol} before ${first}` : undefined;
}

/** Per underlying: of the run's bar times, how many could read a signal, and how many were rebuilt. */
export function optionsCoverage(
  steps: readonly number[],
  options: ReadonlyMap<string, readonly OptionSignal[]>,
  symbol: (id: string) => string,
): OptionsCoverage[] {
  const nyDateOf = (ms: number) => nyDate(new Date(ms));
  return [...options].map(([instrumentId, list]) => {
    let withData = 0;
    let rebuilt = 0;
    for (const t of steps) {
      const s = signalAt(list, t, nyDateOf);
      if (!s) continue;
      withData++;
      if (s.source === 'rebuilt') rebuilt++;
    }
    return { instrumentId, symbol: symbol(instrumentId), bars: steps.length, withData, rebuilt };
  });
}

/** One summary line per underlying, e.g. "SPY: options data on 180 of 252 bars (72 without)". */
export function describeCoverage(c: OptionsCoverage): string {
  const without = c.bars - c.withData;
  let text = `${c.symbol}: options data on ${c.withData} of ${c.bars} bars (${without} without)`;
  if (c.rebuilt > 0)
    text += `; ${c.rebuilt} read history rebuilt from option bars, which is approximate`;
  return text;
}
