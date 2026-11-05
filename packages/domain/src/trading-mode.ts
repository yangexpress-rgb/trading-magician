/**
 * Paper-only guard for Phases 0–3 (Design v1.0 §18, §21: "Do not enable live
 * trading as part of the first implementation milestone").
 *
 * `live` is part of the vocabulary so the schema can grow into it, but no code
 * path may accept it until LIVE_TRADING_ENABLED is deliberately changed in a
 * reviewed Phase 7 change.
 */
export const TRADING_MODES = ['paper', 'live'] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

export const LIVE_TRADING_ENABLED = false as const;

export class LiveTradingDisabledError extends Error {
  constructor() {
    super('Live trading is not enabled in this build. Only paper mode is allowed.');
    this.name = 'LiveTradingDisabledError';
  }
}

export function isTradingMode(value: unknown): value is TradingMode {
  return typeof value === 'string' && (TRADING_MODES as readonly string[]).includes(value);
}

/** Throws unless `mode` is a mode this build is allowed to operate in. */
export function assertAllowedTradingMode(mode: unknown): asserts mode is 'paper' {
  if (mode === 'paper') return;
  if (mode === 'live' && !LIVE_TRADING_ENABLED) throw new LiveTradingDisabledError();
  throw new TypeError(`Unknown trading mode: ${String(mode)}`);
}
