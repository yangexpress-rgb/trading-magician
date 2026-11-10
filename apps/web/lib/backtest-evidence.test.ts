import type { Comparison, Expr } from '@tm/domain';
import { CONTEXT_INSTRUMENT_ID } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { comparisonEvidence } from './backtest-explain';

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

describe('comparisonEvidence (N217)', () => {
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
      { id: 'w', truth: false, left: '12', right: '1', eventsAsOf: ['earnings 2026-10-30'] },
      symbol,
    );
    // A plain number is not a data element.
    expect(ev.elements).toHaveLength(1);
    expect(ev.reason).toBe('12 > 1');
    expect(ev.sources).toEqual(['Record: earnings 2026-10-30']);
  });

  it('says when a value had no data', () => {
    const ev = comparisonEvidence(
      upDay,
      { id: 'cmp', truth: null, left: null, right: '103' },
      symbol,
    );
    expect(ev.reason).toBe('Not decided: a value had no data on this bar');
  });
});
