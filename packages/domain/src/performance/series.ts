import Decimal from 'decimal.js';

/**
 * Daily series from stored valuations (ADR 0021). A series has a value on the
 * sessions it was valued; on a session it missed, its last value carries
 * forward. When several are added up, a series' first value arrives as a flow
 * (its starting amount), so a new account is not counted as a gain.
 */

export interface Series {
  /** What the series was worth before its first point: an account's starting equity. */
  start: Decimal;
  points: ReadonlyMap<string, Decimal>;
}

export interface CombinedPoint {
  date: string;
  value: Decimal;
  /** Starting amounts of the series that begin on this date. */
  flow: Decimal;
}

const ZERO = new Decimal(0);

/** Every date any series has, in order. */
export function seriesDates(series: readonly Series[]): string[] {
  const dates = new Set<string>();
  for (const s of series) for (const d of s.points.keys()) dates.add(d);
  return [...dates].sort();
}

export function combineSeries(series: readonly Series[]): CombinedPoint[] {
  const dates = seriesDates(series);
  const last = series.map(() => null as Decimal | null);
  return dates.map((date) => {
    let value = ZERO;
    let flow = ZERO;
    series.forEach((s, i) => {
      const v = s.points.get(date);
      if (v !== undefined) {
        if (last[i] === null) flow = flow.plus(s.start);
        last[i] = v;
      }
      value = value.plus(last[i] ?? ZERO);
    });
    return { date, value, flow };
  });
}

/** How far each value is below the highest value before it (from zero), in its own units. */
export function drawdowns(values: readonly Decimal[]): Decimal[] {
  let peak = ZERO;
  return values.map((v) => {
    if (v.gt(peak)) peak = v;
    return peak.minus(v);
  });
}
