import { describe, expect, it } from 'vitest';
import type { OptionLeg } from '../strategy/schema';
import { addDays } from '../market/calendar';
import { optionFillPrice, optionQuoteProblem, repriceLimit, midLimit } from './quotes';
import { contractListVersion, resolveContract, type ContractListEntry } from './resolver';
import { occSymbol } from './trading';

/** Options brief v0.2 §6.1 worked example: acceptance fixture A2 (ADR 0123). */
const TODAY = '2026-12-01';
const LIST: ContractListEntry[] = [6, 13, 30, 44].flatMap((dte) =>
  [90, 95, 100, 105, 110].flatMap((k) =>
    (['call', 'put'] as const).map((right) => {
      const expiry = addDays(TODAY, dte);
      return {
        symbol: occSymbol('ZZZ', expiry, right, k),
        expiry,
        right,
        strike: String(k),
        multiplier: '100',
        standard: true,
      };
    }),
  ),
);
const spec = (over: Partial<OptionLeg> = {}): OptionLeg => ({
  right: 'call',
  strikeRule: { type: 'moneynessPct', pct: 5 },
  expiryRule: { targetDte: 30, minDte: 7 },
  ...over,
});
const pick = (s: OptionLeg, list = LIST, price: string | number = '100.00', date = TODAY) =>
  resolveContract({ spec: s, underlying: 'ZZZ', underlyingPrice: price, decisionDate: date, list });

describe('A2: the §6.1 worked example', () => {
  it('picks the 105 call, the 95 put and the 100 at the money, all at DTE 30', () => {
    const call = pick(spec());
    expect(call).toMatchObject({ ok: true, dte: 30, contract: { strike: '105', right: 'call' } });
    expect(call.ok && call.contract.symbol).toBe('ZZZ261231C00105000');
    const put = pick(spec({ right: 'put' }));
    expect(put).toMatchObject({ ok: true, dte: 30, contract: { strike: '95', right: 'put' } });
    const atm = pick(spec({ strikeRule: { type: 'atm' } }));
    expect(atm).toMatchObject({ ok: true, dte: 30, contract: { strike: '100' } });
  });
});

describe('the picker rules (§6.1)', () => {
  it('excludes expiries under minDte and takes the later expiry on a tie', () => {
    // target 9: DTE 6 is under minDte 7; 13 is the only candidate nearer than 30.
    expect(pick(spec({ expiryRule: { targetDte: 9, minDte: 7 } }))).toMatchObject({ dte: 13 });
    // target 37: 30 and 44 are both 7 away, so the later (44).
    expect(pick(spec({ expiryRule: { targetDte: 37, minDte: 7 } }))).toMatchObject({ dte: 44 });
  });
  it('on a strike tie takes the one closer to the money', () => {
    // 2.5% OTM from 100 is 102.5: equally near 100 and 105.
    const s = { strikeRule: { type: 'moneynessPct' as const, pct: 2.5 } };
    expect(pick(spec(s))).toMatchObject({ contract: { strike: '100' } });
    expect(pick(spec({ ...s, right: 'put' }))).toMatchObject({ contract: { strike: '100' } });
  });
  it('allows in the money with a negative percentage', () => {
    expect(pick(spec({ strikeRule: { type: 'moneynessPct', pct: -10 } }))).toMatchObject({
      contract: { strike: '90' },
    });
  });
  it('refuses rather than substitutes, in plain words', () => {
    const r = pick(spec({ expiryRule: { targetDte: 30, minDte: 60 } }));
    expect(r).toEqual({
      ok: false,
      code: 'no_expiry',
      message:
        'No call contract near the target strike expiring in about 30 days was available for ZZZ',
    });
    expect(pick(spec(), [])).toMatchObject({ ok: false, code: 'no_list' });
    expect(pick(spec(), LIST, 0)).toMatchObject({ ok: false, code: 'no_price' });
  });
  it('never picks an adjusted contract or one listed after the decision date', () => {
    const marked = LIST.map((c) =>
      c.strike === '105' && c.right === 'call' ? { ...c, multiplier: '150' } : c,
    );
    expect(pick(spec(), marked)).toMatchObject({ contract: { strike: '100' } });
    const nonStd = LIST.map((c) => (c.strike === '105' ? { ...c, standard: false } : c));
    expect(pick(spec(), nonStd)).toMatchObject({ contract: { strike: '100' } });
    const later = LIST.map((c) => (c.strike === '105' ? { ...c, listedOn: addDays(TODAY, 1) } : c));
    expect(pick(spec(), later)).toMatchObject({ contract: { strike: '100' } });
  });
  it('never enters on the expiry date, even with minDte 0', () => {
    const list = LIST.map((c) => ({
      ...c,
      expiry: c.expiry === addDays(TODAY, 6) ? TODAY : c.expiry,
    }));
    expect(pick(spec({ expiryRule: { targetDte: 1, minDte: 0 } }), list)).toMatchObject({
      dte: 13,
    });
  });
  it('is deterministic whatever the list order (§6.5)', () => {
    const shuffled = [...LIST].reverse();
    expect(pick(spec(), shuffled)).toEqual(pick(spec()));
    expect(contractListVersion(TODAY, shuffled)).toBe(contractListVersion(TODAY, LIST));
  });
});

describe('quotes (§§7.1, 8.2) and the back-test fill (§11.1)', () => {
  const now = new Date('2026-12-01T15:00:00Z');
  const q = (bid: string, ask: string, ageSec = 5) => ({
    bid,
    ask,
    at: new Date(now.getTime() - ageSec * 1000).toISOString(),
  });
  const gate = (quote: ReturnType<typeof q>, marketOpen = true) =>
    optionQuoteProblem({ quote, now, marketOpen, contract: 'ZZZ 105 call' });
  it('refuses a quote 90 seconds old naming its age (A8)', () => {
    expect(gate(q('1.90', '2.10', 90))).toMatchObject({
      code: 'option_quote_stale',
      message:
        "The order for the ZZZ 105 call wasn't sent because its quote was 90 seconds old (the limit is 60)",
    });
    expect(gate(q('1.90', '2.10', 90), false)).toBeNull();
  });
  it('refuses a 45% spread naming its width (A8)', () => {
    // bid 1.55, ask 2.45: spread 0.90 on mid 2.00 = 45%.
    expect(gate(q('1.55', '2.45'))).toMatchObject({
      code: 'option_spread_wide',
      message:
        "The order for the ZZZ 105 call wasn't sent because its spread was 45% of the mid (the limit is 30%)",
    });
    expect(gate(q('1.75', '2.25'))).toBeNull();
    expect(gate(q('0', '0'))).toMatchObject({ code: 'option_quote_missing' });
  });
  it('limits at the mid and re-prices a third of the way to the touch', () => {
    expect(midLimit({ bid: '1.90', ask: '2.10' })?.toString()).toBe('2');
    expect(repriceLimit({ bid: '1.90', ask: '2.20' }, 'buy')?.toString()).toBe('2.1');
    expect(repriceLimit({ bid: '1.90', ask: '2.20' }, 'sell')?.toString()).toBe('2');
  });
  it('fills a back-test buy at mid + 5% and a sell at mid − 5%', () => {
    expect(optionFillPrice('2.00', 'buy').toString()).toBe('2.1');
    expect(optionFillPrice('2.00', 'sell').toString()).toBe('1.9');
  });
});
