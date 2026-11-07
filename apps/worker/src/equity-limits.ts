import Decimal from 'decimal.js';

/**
 * A runtime's equity and its loss limits on one pass (§8.6). Equity is paper
 * capital plus the runtime's cash plus its holdings at their marks. A holding
 * with no mark this pass (a quote that timed out or failed) makes equity
 * incomplete, not lower: counting it as worth nothing would look like a loss
 * of its whole value (review M1). Then neither limit is judged, and neither
 * the day's starting equity nor the peak is recorded from the incomplete
 * figure; the caller holds new entries for the pass instead. Prices that stay
 * missing pause the strategy through the feed watch.
 */
export interface EquityLimitsInput {
  startingCapital: Decimal.Value;
  cash: Decimal;
  positions: ReadonlyMap<string, Decimal>;
  marks: ReadonlyMap<string, Decimal | undefined>;
  /** New York date of this pass. */
  today: string;
  day: { date: string; startEquity: string } | undefined;
  peakEquity: string | undefined;
  dailyLossLimit?: string | undefined;
  maxDrawdownPct?: string | undefined;
}

export interface EquityLimits {
  /** Capital, cash and the marked holdings; low when `complete` is false. */
  equity: Decimal;
  /** Whether every holding had a mark. */
  complete: boolean;
  /** Gross exposure of the marked holdings. */
  gross: Decimal;
  day: { date: string; startEquity: string } | undefined;
  peakEquity: string | undefined;
  dailyLossHit: boolean;
  drawdownHit: boolean;
}

export function equityLimits(input: EquityLimitsInput): EquityLimits {
  let gross = new Decimal(0);
  let net = new Decimal(0);
  let unmarked = false;
  for (const [id, q] of input.positions) {
    if (q.isZero()) continue;
    const px = input.marks.get(id);
    if (!px) {
      unmarked = true;
      continue;
    }
    gross = gross.plus(q.abs().times(px));
    net = net.plus(q.times(px));
  }
  const equity = new Decimal(input.startingCapital).plus(input.cash).plus(net);
  if (unmarked) {
    return {
      equity,
      complete: false,
      gross,
      day: input.day,
      peakEquity: input.peakEquity,
      dailyLossHit: false,
      drawdownHit: false,
    };
  }
  const day =
    input.day?.date === input.today
      ? input.day
      : { date: input.today, startEquity: equity.toString() };
  const peak = Decimal.max(equity, input.peakEquity ?? equity);
  const dailyLossHit = Boolean(
    input.dailyLossLimit && new Decimal(day.startEquity).minus(equity).gte(input.dailyLossLimit),
  );
  const drawdownHit = Boolean(
    input.maxDrawdownPct &&
    peak.gt(0) &&
    peak.minus(equity).div(peak).times(100).gte(input.maxDrawdownPct),
  );
  return {
    equity,
    complete: true,
    gross,
    day,
    peakEquity: peak.toString(),
    dailyLossHit,
    drawdownHit,
  };
}
