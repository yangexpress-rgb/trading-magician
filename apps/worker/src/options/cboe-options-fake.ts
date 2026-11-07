import {
  addDays,
  bsmDelta,
  bsmGamma,
  bsmPrice,
  isoToZonedWallTime,
  nyDate,
  NYSE_ZONE,
  weekday,
} from '@tm/domain';
import type { Fetch } from './cboe-options';

/**
 * Tests only (`CBOE_OPTIONS_FAKE=true`): a stand-in for CBOE's delayed-quotes
 * CDN. It answers any symbol with a chain priced by Black-Scholes on a smile
 * around a made-up volatility, in CBOE's file shape, stamped 15 minutes before
 * now in New York wall time. `underlying` sets the price a symbol is quoted
 * around; unknown symbols get one derived from their letters.
 */
export function fakeCboeOptionsFetch(
  now: () => Date,
  underlying: (symbol: string) => number | undefined = () => undefined,
): Fetch {
  return async (url) => {
    const m = /\/([A-Z/._]+)\.json$/.exec(new URL(url).pathname);
    if (!m) return new Response('not found', { status: 404 });
    const symbol = decodeURIComponent(m[1] as string);
    const at = new Date(now().getTime() - 15 * 60_000);
    const S =
      underlying(symbol) ?? 50 + ([...symbol].reduce((a, c) => a + c.charCodeAt(0), 0) % 400);
    const body = {
      timestamp: (isoToZonedWallTime(at.toISOString(), NYSE_ZONE) ?? '').replace('T', ' ') + ':00',
      data: { symbol, current_price: S, close: S, options: fakeChain(symbol, S, nyDate(at)) },
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** Fridays for the next 10 weeks plus the next three third-Friday monthlies. */
function expiries(asOf: string): string[] {
  const out = new Set<string>();
  let d = addDays(asOf, 1);
  while (out.size < 10) {
    if (weekday(d) === 5) out.add(d);
    d = addDays(d, 1);
  }
  for (let months = 0, x = asOf; months < 4; x = addDays(x, 1)) {
    const dom = Number(x.slice(8));
    if (weekday(x) === 5 && dom >= 15 && dom <= 21 && x > asOf) {
      out.add(x);
      months++;
    }
  }
  return [...out].sort();
}

function fakeChain(symbol: string, S: number, asOf: string) {
  const rows: Record<string, unknown>[] = [];
  const step = S >= 200 ? 5 : S >= 50 ? 2.5 : 1;
  const r = 0.04;
  for (const expiry of expiries(asOf)) {
    const days = Math.round((Date.parse(expiry) - Date.parse(asOf)) / 86_400_000);
    const T = days / 365;
    const atm = Math.round(S / step) * step;
    for (let k = atm - 15 * step; k <= atm + 15 * step; k += step) {
      if (k <= 0) continue;
      // A smile: higher IV for low strikes, rising slightly with maturity.
      const sigma =
        0.2 + 0.25 * Math.max(0, (S - k) / S) + 0.05 * Math.max(0, (k - S) / S) + 0.01 * T;
      for (const right of ['call', 'put'] as const) {
        const p = { S, K: k, T, r, q: 0, sigma };
        const theo = bsmPrice(right, p);
        const spread = Math.max(0.02, theo * 0.04);
        const bid = Math.max(0, Math.round((theo - spread / 2) * 100) / 100);
        const ask = Math.round((theo + spread / 2) * 100) / 100;
        const yymmdd = expiry.slice(2).replace(/-/g, '');
        const strike = String(Math.round(k * 1000)).padStart(8, '0');
        rows.push({
          option: `${symbol}${yymmdd}${right === 'call' ? 'C' : 'P'}${strike}`,
          bid,
          bid_size: 0,
          ask,
          ask_size: 0,
          iv: Math.round(sigma * 10_000) / 10_000,
          open_interest: Math.round(5000 * Math.exp(-(((k - S) / S) ** 2) * 50)),
          volume: Math.round(2000 * Math.exp(-(((k - S) / S) ** 2) * 80)),
          delta: bsmDelta(right, p),
          gamma: bsmGamma(p),
          vega: 0,
          theta: 0,
          rho: 0,
          theo,
          last_trade_price: theo,
          last_trade_time: null,
          prev_day_close: theo,
        });
      }
    }
  }
  return rows;
}
