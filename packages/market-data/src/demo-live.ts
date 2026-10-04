import type { LiveQuoteProvider, Quote, QuoteRequest } from '@tm/domain';
import Decimal from 'decimal.js';
import { demoSegmentAt, DEMO_PROFILES } from './demo-history';
import { mulberry32, seedOf } from './random';

/**
 * A simulated live feed for the DEMO instruments (§20 #1 default, awaiting
 * confirmation). It follows real NYSE hours and holidays: during the regular
 * session the price walks through each generated hourly bar, from its open to
 * its high and low and on to its close, so live quotes agree with the bars a
 * strategy evaluates. Outside the session it returns the last quote of the
 * previous session, which ages and then reads as stale.
 */

export const DEMO_LIVE_SOURCE = 'demo-live';
/** Share of the average volume per minute one order may take at a quote. */
const QUOTE_SIZE_SHARE = 0.1;

export interface DemoLiveFeedOptions {
  /** The feed's clock; tests drive it directly. */
  now?: () => Date;
}

const cents = (x: number) => new Decimal(x).toDecimalPlaces(2);

/** Price at fraction `f` of a bar: open, then the nearer extreme, the other, then close. */
function pathPrice(
  s: { open: number; high: number; low: number; close: number; start: string },
  f: number,
): number {
  const r = mulberry32(seedOf(`path|${s.start}|${s.open}`));
  const highFirst = r() < 0.5;
  const a = 0.15 + 0.3 * r();
  const b = a + 0.15 + 0.3 * r();
  const points: [number, number][] = [
    [0, s.open],
    [a, highFirst ? s.high : s.low],
    [Math.min(b, 0.95), highFirst ? s.low : s.high],
    [1, s.close],
  ];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i] as [number, number];
    const [x0, y0] = points[i - 1] as [number, number];
    if (f <= x1) return y0 + ((y1 - y0) * (f - x0)) / (x1 - x0 || 1);
  }
  return s.close;
}

export function createDemoLiveFeed(options: DemoLiveFeedOptions = {}): LiveQuoteProvider {
  const now = options.now ?? (() => new Date());
  return {
    id: DEMO_LIVE_SOURCE,
    async latestQuote(ref: QuoteRequest): Promise<Quote | undefined> {
      const profile = DEMO_PROFILES[ref.symbol];
      if (!profile) return undefined;
      const t = now();
      const found = demoSegmentAt(ref.symbol, t);
      if (!found) return undefined;
      const { segment: s, inSession } = found;
      const start = Date.parse(s.start);
      const end = Date.parse(s.end);
      // Quotes update once a second; outside the session the last one stands.
      const at = inSession ? Math.floor(t.getTime() / 1000) * 1000 : end;
      const f = Math.min(1, Math.max(0, (at - start) / (end - start)));
      const last = cents(Math.min(s.high, Math.max(s.low, pathPrice(s, f))));
      const half = Decimal.max(new Decimal('0.01'), last.times('0.0001')).toDecimalPlaces(2);
      const perMinute = s.volume / ((end - start) / 60_000);
      return {
        instrumentId: ref.instrumentId,
        symbol: ref.symbol,
        bid: last.minus(half),
        ask: last.plus(half),
        last,
        size: new Decimal(Math.max(1, Math.floor(perMinute * QUOTE_SIZE_SHARE))),
        at: new Date(at).toISOString(),
        receivedAt: t.toISOString(),
        source: DEMO_LIVE_SOURCE,
        marketOpen: inSession,
      };
    },
  };
}
