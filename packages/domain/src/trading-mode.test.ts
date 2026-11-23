import { describe, expect, it } from 'vitest';
import {
  assertAllowedTradingMode,
  isTradingMode,
  liveTradingEnabled,
  LiveTradingDisabledError,
} from './trading-mode';

describe('trading mode guard', () => {
  it('ships with live trading off unless the server sets the flag to exactly "true"', () => {
    expect(liveTradingEnabled({})).toBe(false);
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: 'false' })).toBe(false);
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: '1' })).toBe(false);
    expect(liveTradingEnabled({ LIVE_TRADING_ENABLED: 'true' })).toBe(true);
  });

  it('allows live mode only with the flag on', () => {
    expect(() => assertAllowedTradingMode('live', true)).not.toThrow();
  });

  it('allows paper mode', () => {
    expect(() => assertAllowedTradingMode('paper')).not.toThrow();
  });

  it('rejects live mode', () => {
    expect(() => assertAllowedTradingMode('live', false)).toThrow(LiveTradingDisabledError);
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
