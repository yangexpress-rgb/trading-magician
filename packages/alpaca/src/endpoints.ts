/**
 * Alpaca endpoints (ADR 0017, ADR 0109). A paper account's orders go only to
 * the paper trading host. A live account's go only to the live trading host,
 * and only when the caller says live trading is on (the server's
 * LIVE_TRADING_ENABLED flag); otherwise the live host is refused outright.
 * Market data has one host for paper and live accounts alike.
 */
export const ALPACA_PAPER_TRADING_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_LIVE_TRADING_URL = 'https://api.alpaca.markets';
export const ALPACA_DATA_URL = 'https://data.alpaca.markets';

/** The free real-time feed every Alpaca account gets: the IEX exchange only. */
export const ALPACA_DATA_FEED = 'iex';

const LIVE_TRADING_HOSTS = new Set(['api.alpaca.markets', 'broker-api.alpaca.markets']);

export class LiveEndpointError extends Error {
  constructor() {
    super('This Alpaca trading host is not allowed for this account');
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

/**
 * Throws unless `url` is the trading host of this environment: the paper host
 * for paper; the live host for live, and only with live trading on.
 */
export function assertTradingUrl(
  url: string,
  environment: 'paper' | 'live',
  options: { allowLocal?: boolean; liveEnabled?: boolean } = {},
) {
  if (environment === 'paper') {
    assertPaperTradingUrl(url, options);
    return;
  }
  if (!options.liveEnabled) throw new LiveEndpointError();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LiveEndpointError();
  }
  if (parsed.origin === ALPACA_LIVE_TRADING_URL) return;
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
