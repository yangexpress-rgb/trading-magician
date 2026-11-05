import { describe, expect, it } from 'vitest';
import {
  assertAllowedTradingMode,
  isTradingMode,
  LIVE_TRADING_ENABLED,
  LiveTradingDisabledError,
} from './trading-mode';

describe('trading mode guard', () => {
  it('ships with live trading disabled', () => {
    expect(LIVE_TRADING_ENABLED).toBe(false);
  });

  it('allows paper mode', () => {
    expect(() => assertAllowedTradingMode('paper')).not.toThrow();
  });

  it('rejects live mode', () => {
    expect(() => assertAllowedTradingMode('live')).toThrow(LiveTradingDisabledError);
  });

  it.each([undefined, null, '', 'PAPER', 'real', 1])('rejects unknown mode %j', (mode) => {
    expect(() => assertAllowedTradingMode(mode)).toThrow(TypeError);
  });

  it('recognises the mode vocabulary', () => {
    expect(isTradingMode('paper')).toBe(true);
    expect(isTradingMode('live')).toBe(true);
    expect(isTradingMode('demo')).toBe(false);
  });
});
