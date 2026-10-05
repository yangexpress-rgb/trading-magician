/**
 * Alpaca endpoints (ADR 0017). Only the paper trading host is ever called for
 * orders and accounts; the live trading host is refused outright, alongside
 * the app-wide paper-only guard (ADR 0002). Market data has one host for paper
 * and live accounts alike.
 */
export const ALPACA_PAPER_TRADING_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_DATA_URL = 'https://data.alpaca.markets';

/** The free real-time feed every Alpaca account gets: the IEX exchange only. */
export const ALPACA_DATA_FEED = 'iex';

const LIVE_TRADING_HOSTS = new Set(['api.alpaca.markets', 'broker-api.alpaca.markets']);

export class LiveEndpointError extends Error {
  constructor() {
    super('Only Alpaca paper trading is allowed');
    this.name = 'LiveEndpointError';
  }
}

/** Throws unless `url` is the paper trading host (or a local fake in tests). */
export function assertPaperTradingUrl(url: string, options: { allowLocal?: boolean } = {}) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LiveEndpointError();
  }
  if (LIVE_TRADING_HOSTS.has(parsed.hostname)) throw new LiveEndpointError();
  if (parsed.origin === ALPACA_PAPER_TRADING_URL) return;
  if (options.allowLocal && isLocal(parsed)) return;
  throw new LiveEndpointError();
}

export function assertDataUrl(url: string, options: { allowLocal?: boolean } = {}) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Not an Alpaca market-data URL');
  }
  if (parsed.origin === ALPACA_DATA_URL) return;
  if (options.allowLocal && isLocal(parsed)) return;
  throw new Error('Not an Alpaca market-data URL');
}

const isLocal = (u: URL) =>
  u.protocol === 'fake:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1';
