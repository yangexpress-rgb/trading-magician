import type { DeriveRow } from './derive';

/**
 * The canned one-day SPY chain of the options data brief v2 §7, used by
 * fixtures F1 (ingest) and F2 (derive). The IV, delta and gamma columns are
 * the pricing package's computed outputs; the derive step takes them as
 * inputs. The day is a Saturday so that the first expiry, a third Friday,
 * is exactly 20 calendar days out (a weekday 20 days before a Friday doesn't
 * exist); the derive step doesn't care which weekday it is.
 */
export const F2_AS_OF = '2026-11-28';
export const F2_EXPIRY_1 = '2026-12-18'; // 20 days, the December monthly
export const F2_EXPIRY_2 = '2027-01-12'; // 45 days
export const F2_S = 600;
/** r − q small: the forward is about 601.6 at 20 days, so 600 is at the money. */
export const F2_R = 0.05;
export const F2_Q = 0;

type Row = [
  strike: number,
  right: 'call' | 'put',
  bid: number | null,
  ask: number | null,
  iv: number,
  delta: number,
  gamma: number,
  oi: number,
  volume: number,
];

const EXPIRY_1: Row[] = [
  [590, 'call', 13.0, 13.2, 0.17, 0.75, 0.006, 4000, 4000],
  [590, 'put', 3.0, 3.2, 0.2, -0.25, 0.006, 8000, 8000],
  [600, 'call', 8.0, 8.2, 0.18, 0.52, 0.01, 10000, 5000],
  [600, 'put', 7.5, 7.7, 0.19, -0.48, 0.01, 12000, 6000],
  [610, 'call', 4.0, 4.2, 0.16, 0.25, 0.006, 9000, 9000],
  [610, 'put', 12.0, 12.2, 0.21, -0.75, 0.006, 3000, 3000],
];
const EXPIRY_2: Row[] = [
  [590, 'call', null, null, 0.19, 0.75, 0.005, 3000, 2000],
  [590, 'put', null, null, 0.22, -0.25, 0.005, 6000, 5000],
  [600, 'call', null, null, 0.2, 0.52, 0.008, 8000, 4000],
  [600, 'put', null, null, 0.21, -0.48, 0.008, 9000, 5000],
  [610, 'call', null, null, 0.18, 0.25, 0.005, 7000, 6000],
  [610, 'put', null, null, 0.23, -0.75, 0.005, 2000, 1000],
];

const toRow =
  (expiry: string) =>
  ([strike, right, bid, ask, iv, delta, gamma, oi, volume]: Row): DeriveRow => ({
    expiry,
    strike,
    right,
    bid,
    ask,
    volume,
    openInterest: oi,
    iv,
    delta,
    gamma,
  });

export const F2_ROWS: DeriveRow[] = [
  ...EXPIRY_1.map(toRow(F2_EXPIRY_1)),
  ...EXPIRY_2.map(toRow(F2_EXPIRY_2)),
];

/** The rank fixture's prior IV30 values (a 5-day sample window). */
export const F2_PRIOR_IV30 = [0.16, 0.17, 0.185, 0.19, 0.21];
export const F2_REALIZED_VOL_20 = 0.16;
