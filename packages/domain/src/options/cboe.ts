import { regularSession, nyDate, NYSE_ZONE } from '../market/calendar';
import type { IndexDataTerms } from '../market/indices';
import { zonedWallTimeToIso } from '../time';
import type { OptionRight } from './pricing';

/**
 * CBOE's delayed-quotes CDN (options data brief v2 §1): one keyless JSON file
 * per underlying with the whole chain, about 15 minutes delayed. Snapshot
 * only; the app keeps history by storing one snapshot a day.
 */

/** The CDN folder; the worker's `CBOE_OPTIONS_URL` overrides it. */
export const CBOE_OPTIONS_URL = 'https://cdn.cboe.com/api/global/delayed_quotes/options';

/** The file for an underlying (indices take a leading underscore, which the app doesn't use). */
export const cboeOptionsPath = (symbol: string) =>
  `/${encodeURIComponent(symbol.toUpperCase().replace(/\./g, '/'))}.json`;

/**
 * The licensing position (brief §8), next to the provider as for the VIX:
 * CBOE's delayed data is free for internal use only. Redistributing the chain
 * needs a Data Agreement, and data derived from it is fee-liable under Cboe's
 * policy. So the app stores chains only to compute its own signals and never
 * shows a chain, a quote or a greek to anyone. Reviewing the terms for a paid
 * service is a launch-gate item.
 */
export const CBOE_OPTIONS_DISPLAY_TERMS: IndexDataTerms = {
  owner: 'Cboe Global Markets',
  attribution: 'Options data: Cboe Global Markets (delayed), signals computed by the app',
  reviewed: false,
  note:
    "Cboe's delayed options quotes are free for internal use only. Redistributing the chain needs a " +
    'Data Agreement and derived data is fee-liable under Cboe policy. The app shows only its own ' +
    'derived signals; review the terms (or license the data) before a paid launch.',
};

/** One contract of the chain as the file gives it. */
export interface CboeOptionRow {
  occSymbol: string;
  expiry: string;
  strike: number;
  right: OptionRight;
  bid: number | null;
  bidSize: number | null;
  ask: number | null;
  askSize: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  /** As reported; the derive step never uses these. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
  theo: number | null;
}

export interface CboeChain {
  /** The file's own timestamp (UTC ISO). */
  fileTimestamp: string;
  rows: CboeOptionRow[];
  /** Rows left out as malformed or impossible. */
  skipped: number;
}

export class CboeOptionsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CboeOptionsFormatError';
  }
}

/** An OCC option symbol such as SPY261218C00600000: root, expiry, right, strike × 1000. */
export function parseOccSymbol(
  symbol: string,
): { root: string; expiry: string; right: OptionRight; strike: number } | undefined {
  const m = /^([A-Z0-9./]{1,10}?)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(symbol.trim());
  if (!m) return undefined;
  const [, root, yy, mm, dd, cp, strike] = m as unknown as string[];
  const month = Number(mm);
  const day = Number(dd);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const expiry = `20${yy}-${mm}-${dd}`;
  if (Number.isNaN(Date.parse(`${expiry}T00:00:00Z`))) return undefined;
  const k = Number(strike) / 1000;
  if (!(k > 0)) return undefined;
  return { root: root as string, expiry, right: cp === 'C' ? 'call' : 'put', strike: k };
}

const num = (v: unknown): number | null | 'bad' => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : 'bad';
};

/** The file's timestamp: New York wall time ("2026-11-06 16:14:22"), or an ISO instant. */
export function parseCboeTimestamp(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return undefined;
  const t = text.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/.exec(t);
  if (!m) return undefined;
  const iso = zonedWallTimeToIso(`${m[1]}T${m[2]}${m[3] ?? ''}`, NYSE_ZONE);
  return iso ? new Date(iso).toISOString() : undefined;
}

/**
 * Parses a CBOE delayed-quotes file, validating each row (brief §5.1): a row
 * is left out, and counted, when its symbol or a number doesn't parse, the
 * bid is negative, the ask is below the bid, the IV is negative, the delta is
 * outside −1…1 or the gamma is negative. Sizes are kept but never used.
 */
export function parseCboeOptions(json: unknown): CboeChain {
  if (!json || typeof json !== 'object') throw new CboeOptionsFormatError('not a JSON object');
  const root = json as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const fileTimestamp = parseCboeTimestamp(root.timestamp ?? data.timestamp);
  if (!fileTimestamp) throw new CboeOptionsFormatError('the file has no timestamp');
  const options = data.options;
  if (!Array.isArray(options)) throw new CboeOptionsFormatError('the file has no options list');
  const rows: CboeOptionRow[] = [];
  let skipped = 0;
  for (const raw of options as unknown[]) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const occ = typeof o.option === 'string' ? parseOccSymbol(o.option) : undefined;
    const fields = {
      bid: num(o.bid),
      bidSize: num(o.bid_size),
      ask: num(o.ask),
      askSize: num(o.ask_size),
      last: num(o.last_trade_price),
      volume: num(o.volume),
      openInterest: num(o.open_interest),
      iv: num(o.iv),
      delta: num(o.delta),
      gamma: num(o.gamma),
      vega: num(o.vega),
      theta: num(o.theta),
      rho: num(o.rho),
      theo: num(o.theo),
    };
    if (!occ || Object.values(fields).includes('bad')) {
      skipped++;
      continue;
    }
    const f = fields as { [K in keyof typeof fields]: number | null };
    const impossible =
      (f.bid !== null && f.bid < 0) ||
      (f.bid !== null && f.ask !== null && f.ask < f.bid) ||
      (f.iv !== null && f.iv < 0) ||
      (f.delta !== null && (f.delta < -1 || f.delta > 1)) ||
      (f.gamma !== null && f.gamma < 0);
    if (impossible) {
      skipped++;
      continue;
    }
    rows.push({
      occSymbol: (o.option as string).trim(),
      expiry: occ.expiry,
      strike: occ.strike,
      right: occ.right,
      ...f,
      volume: f.volume === null ? null : Math.round(f.volume),
      openInterest: f.openInterest === null ? null : Math.round(f.openInterest),
    });
  }
  return { fileTimestamp, rows, skipped };
}

/** The last trading day strictly before `date`. */
function previousTradingDay(date: string): string | undefined {
  const d = new Date(`${date}T00:00:00Z`);
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const s = d.toISOString().slice(0, 10);
    if (regularSession(s)) return s;
  }
  return undefined;
}

/**
 * The stale-file guard (brief §5.1): a file stamped before the previous
 * trading day's close is not today's data. `beforeClose` says the file
 * predates today's own close, which the ingest report flags.
 */
export function cboeFileFreshness(
  asOfDate: string,
  fileTimestamp: string,
): { stale: boolean; beforeClose: boolean } {
  const prev = previousTradingDay(asOfDate);
  const prevClose = prev ? regularSession(prev)?.close : undefined;
  const todayClose = regularSession(asOfDate)?.close;
  const t = Date.parse(fileTimestamp);
  return {
    stale: prevClose !== undefined && t < Date.parse(prevClose),
    beforeClose:
      todayClose !== undefined && t < Date.parse(todayClose) && nyDate(fileTimestamp) <= asOfDate,
  };
}
