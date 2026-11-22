import { describe, expect, it } from 'vitest';
import { safetyCloseReason, strategyTrailDue } from './safety-close';
import { strategyTrailText } from './strategy-trail';

describe('safety close reasons (N306)', () => {
  it('names the trigger in plain words, with the trailing stop’s figures', () => {
    const detail = strategyTrailText('1', {
      bestEquity: '98974.185',
      invested: '47494.13',
      firedEquity: '98488.68',
    });
    expect(safetyCloseReason({ kind: 'strategy_trailing_stop', detail })).toBe(
      'Trailing stop (whole strategy), a Risk limit: The strategy fell $485.51 below its best ' +
        'since entry, more than 1% of the $47,494.13 in its positions ($474.94), so every ' +
        'position was closed.',
    );
    expect(safetyCloseReason({ kind: 'strategy_trailing_stop' })).toMatch(
      /^Trailing stop \(whole strategy\), a Risk limit: /,
    );
    expect(safetyCloseReason({ kind: 'session_end' })).toMatch(/^Flatten at session end: /);
    expect(safetyCloseReason({ kind: 'leg_failed' })).toMatch(/did not fill/);
  });

  it('judges the trailing stop on the strategy’s own bars', () => {
    // Daily strategy holding overnight: not on a morning pass, only when a bar closes.
    expect(strategyTrailDue({ intraday: false, newBar: false, holding: true })).toBe(false);
    expect(strategyTrailDue({ intraday: false, newBar: true, holding: true })).toBe(true);
    // Intraday rules: every pass.
    expect(strategyTrailDue({ intraday: true, newBar: false, holding: true })).toBe(true);
    // Flat: reset at once.
    expect(strategyTrailDue({ intraday: false, newBar: false, holding: false })).toBe(true);
  });
});
