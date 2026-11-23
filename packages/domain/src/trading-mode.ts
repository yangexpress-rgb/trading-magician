/**
 * The live gate (Phase 7 brief §6, ADR 0109). Paper is always allowed. Live
 * trading is a capability the app gains only when the server is started with
 * `LIVE_TRADING_ENABLED=true`; with it off (the default) no live account can
 * be added, started or sent an order, and the app behaves as it did on paper.
 * Setting the flag is a deliberate operator step, never part of a build.
 */
export const TRADING_MODES = ['paper', 'live'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

type Env = Record<string, string | undefined>;

const processEnv = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

/** Whether this server may trade live: only the exact value "true" turns it on. */
export function liveTradingEnabled(env: Env = processEnv()): boolean {
  return env.LIVE_TRADING_ENABLED === 'true';
}

export class LiveTradingDisabledError extends Error {
  constructor() {
    super('Live trading is turned off on this server. Only paper accounts can trade.');
    this.name = 'LiveTradingDisabledError';
  }
}

export function isTradingMode(value: unknown): value is TradingMode {
  return typeof value === 'string' && (TRADING_MODES as readonly string[]).includes(value);
}

/** Throws unless `mode` is a mode this server may operate in now. */
export function assertAllowedTradingMode(
  mode: unknown,
  enabled: boolean = liveTradingEnabled(),
): asserts mode is TradingMode {
  if (mode === 'paper') return;
  if (mode === 'live') {
    if (!enabled) throw new LiveTradingDisabledError();
    return;
  }
  throw new TypeError(`Unknown trading mode: ${String(mode)}`);
}

/** Pattern-day-trader awareness (N320): the equity under which brokers limit day trades. */
export const PDT_EQUITY = 25_000;
export const PDT_WARNING =
  'This account is under $25,000 — the broker limits it to 3 day trades in 5 days.';
