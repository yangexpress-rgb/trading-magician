import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  contractInWords,
  effectivePrice,
  occSymbol,
  optionsSettings,
  optionsStartProblem,
  optionsTradingEnabled,
  parseOptionsLevel,
  type OptionsAccountView,
} from './trading';

const account = (over: Partial<OptionsAccountView> = {}): OptionsAccountView => ({
  nickname: 'Opts',
  mode: 'paper',
  simulator: false,
  optionsLevel: 3,
  hasOptionsRuns: false,
  hasEquityRuns: false,
  ...over,
});

describe('the switch (ADR 0123)', () => {
  it('is on only for the exact value "true"', () => {
    expect(optionsTradingEnabled({})).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', 'true ', ''])
      expect(optionsTradingEnabled({ OPTIONS_TRADING_ENABLED: v })).toBe(false);
    expect(optionsTradingEnabled({ OPTIONS_TRADING_ENABLED: 'true' })).toBe(true);
  });
  it('reads settings, falling back on bad values', () => {
    expect(optionsSettings({})).toEqual({
      enabled: false,
      maxSpreadPct: '30',
      fillSlippagePct: '5',
    });
    expect(
      optionsSettings({ OPTIONS_MAX_SPREAD_PCT: '12.5', OPTIONS_FILL_SLIPPAGE_PCT: '0' }),
    ).toMatchObject({ maxSpreadPct: '12.5', fillSlippagePct: '5' });
  });
});

describe('levels, multiplier and OCC', () => {
  it('parses only 0–3', () => {
    expect([0, '1', 2, '3', 4, '12', null, undefined, 'x'].map(parseOptionsLevel)).toEqual([
      0,
      1,
      2,
      3,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
  it('returns the very same price for a multiplier of 1 or none', () => {
    const p = new Decimal('12.34');
    expect(effectivePrice(p, undefined)).toBe(p);
    expect(effectivePrice(p, 1)).toBe(p);
    expect(effectivePrice(p, '1')).toBe(p);
    expect(effectivePrice(p, 100).toString()).toBe('1234');
  });
  it('builds OCC symbols and plain words', () => {
    expect(occSymbol('AAPL', '2025-12-26', 'call', 105)).toBe('AAPL251226C00105000');
    expect(occSymbol('SPY', '2026-01-16', 'put', '612.5')).toBe('SPY260116P00612500');
    expect(() => occSymbol('SPY', '2026-01-16', 'put', '0.0001')).toThrow();
    expect(
      contractInWords({ underlying: 'AAPL', strike: '105', right: 'call', expiry: '2025-12-26' }),
    ).toBe('AAPL 105 call, expiring Fri Dec 26');
  });
});

describe('Start gates (§§5.4–5.6, A10)', () => {
  const on = { enabled: true };
  it('lets an equity strategy start anywhere without options runs, even with the switch off', () => {
    expect(optionsStartProblem({ uses: [], account: account(), enabled: false })).toBeNull();
    expect(
      optionsStartProblem({ uses: [], account: account({ hasOptionsRuns: true }), enabled: false })
        ?.reason,
    ).toBe('equity_account_has_options_runs');
  });
  it('refuses in order: switch, live, simulator, level, equity runs', () => {
    const r = (a: Partial<OptionsAccountView>, enabled = true, uses = ['long'] as const) =>
      optionsStartProblem({ uses: [...uses], account: account(a), enabled })?.reason ?? null;
    expect(r({}, false)).toBe('options_off');
    expect(r({ mode: 'live' })).toBe('options_live');
    expect(r({ simulator: true })).toBe('options_simulator');
    expect(r({ optionsLevel: 1 })).toBe('options_level');
    expect(r({ optionsLevel: undefined })).toBe('options_level');
    expect(r({ optionsLevel: 2 }, true, ['long'])).toBeNull();
    expect(r({ optionsLevel: 2 }, true, ['combo'] as never)).toBe('options_level');
    expect(r({ hasEquityRuns: true })).toBe('options_account_has_equity_runs');
    expect(r({ hasOptionsRuns: true })).toBeNull();
  });
  it('names the level it has and the one needed', () => {
    expect(
      optionsStartProblem({ uses: ['long', 'combo'], account: account({ optionsLevel: 2 }), ...on })
        ?.message,
    ).toBe(
      'Opts is at options level 2 (buying calls and puts); this strategy needs level 3 (spreads).',
    );
    expect(
      optionsStartProblem({ uses: ['long'], account: account({ optionsLevel: undefined }), ...on })
        ?.message,
    ).toBe(
      'Opts hasn’t reported an options level yet; this strategy needs level 2 (buying calls and puts).',
    );
  });
});
