import type { Comparison, Expr } from '@tm/domain';
import { CONTEXT_INSTRUMENT_ID } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { comparisonEvidence, heldExits } from './backtest-explain';

const close = (id: string, offset = 0): Expr => ({
  kind: 'market',
  id,
  instrumentId: CONTEXT_INSTRUMENT_ID,
  field: 'close',
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset,
});
const symbol = () => undefined;

describe('comparisonEvidence (N218)', () => {
  const upDay: Comparison = {
    kind: 'comparison',
    id: 'cmp',
    left: close('now'),
    operator: 'gte',
    right: {
      kind: 'calc',
      id: 'calc',
      op: 'mul',
      args: [close('prev', 1), { kind: 'constant', id: 'k', value: '1.03' }],
    },
  };

  it('names each data element, the values inside a calculation, and why it held', () => {
    const ev = comparisonEvidence(
      upDay,
      { id: 'cmp', truth: true, left: '105.2', right: '103', inputs: { prev: '100' } },
      symbol,
    );
    expect(ev.elements).toEqual([
      { label: 'this instrument close', value: '105.2' },
      { label: '(this instrument close 1 bar ago × 1.03)', value: '103' },
      { label: 'this instrument close 1 bar ago', value: '100', inside: true },
    ]);
    expect(ev.reason).toBe('105.2 ≥ 103');
  });

  it('says why a comparison did not hold, and which records it read', () => {
    const window: Comparison = {
      kind: 'comparison',
      id: 'w',
      left: {
        kind: 'metric',
        id: 'm',
        metric: 'earnings.next_earnings_days',
        params: {},
        instrumentId: CONTEXT_INSTRUMENT_ID,
      },
      operator: 'lte',
      right: { kind: 'constant', id: 'one', value: '1' },
    };
    const ev = comparisonEvidence(
      window,
      {
        id: 'w',
        truth: false,
        left: '12',
        right: '1',
        eventsAsOf: ['Earnings release 2026-10-30'],
      },
      symbol,
    );
    // A plain number is not a data element.
    expect(ev.elements).toHaveLength(1);
    expect(ev.reason).toBe('12 > 1');
    expect(ev.sources).toEqual(['Earnings release Oct 30, 2026']);
  });

  it('says when a value had no data', () => {
    const ev = comparisonEvidence(
      upDay,
      { id: 'cmp', truth: null, left: null, right: '103' },
      symbol,
    );
    expect(ev.reason).toBe('Not decided: a value had no data on this bar');
  });

  it('shows the best close and the close behind a trailing stop in Exit when', () => {
    const trail: Comparison = {
      kind: 'comparison',
      id: 't',
      left: {
        kind: 'position',
        id: 'off',
        field: 'off_peak_pct',
        instrumentId: CONTEXT_INSTRUMENT_ID,
        interval: '1d',
        adjustment: 'split_and_dividend',
        session: 'regular',
      },
      operator: 'gt',
      right: { kind: 'constant', id: 'one', value: '1' },
    };
    const ev = comparisonEvidence(
      trail,
      {
        id: 't',
        truth: true,
        left: '1.07',
        right: '1',
        inputs: { 'off:entry': '53.08', 'off:peak': '53.3', 'off:close': '52.73' },
      },
      symbol,
    );
    expect(ev.elements.slice(1)).toEqual([
      { label: 'Entry price', value: '53.08', inside: true },
      { label: 'Best close since entry', value: '53.3', inside: true },
      { label: 'Close checked', value: '52.73', inside: true },
    ]);
    expect(ev.reason).toBe('1.07 > 1');
  });
});

describe('heldExits (N223)', () => {
  const pos = (id: string, field: string): Comparison => ({
    kind: 'comparison',
    id,
    left: {
      kind: 'position',
      id: `${id}-v`,
      field: field as never,
      instrumentId: CONTEXT_INSTRUMENT_ID,
      interval: '1d',
      adjustment: 'split_and_dividend',
      session: 'regular',
    },
    operator: 'gt',
    right: { kind: 'constant', id: `${id}-k`, value: '1' },
  });
  const tree = {
    kind: 'group' as const,
    id: 'g',
    op: 'or' as const,
    negate: false,
    children: [pos('t', 'off_peak_pct'), pos('d', 'days_held'), pos('a', 'atrs_below_entry')],
  };

  it('names the common exits that held on the bar Exit when fired', () => {
    const checks = [
      { id: 't', truth: true as const },
      { id: 'd', truth: false as const },
      { id: 'a', truth: true as const },
    ];
    expect(heldExits(tree, checks)).toEqual(['trailing stop', 'ATR stop']);
    expect(heldExits(tree, [])).toEqual([]);
  });
});
