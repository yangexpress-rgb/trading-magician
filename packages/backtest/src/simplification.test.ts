import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  A,
  INSTRUMENTS,
  close,
  closes,
  compare,
  constant,
  inputs,
  leg,
  loaded,
  strategy,
} from './test-utils';

/** Acceptance checks for the Strategy Lab simplification (ADR 0049). */
const FROM = '2024-03-04';
const run = (
  def: ReturnType<typeof strategy>,
  values: number[],
  extra: Record<string, number[]> = {},
) => {
  const series = closes(FROM, values);
  return simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs(FROM, series.at(-1)!.start.slice(0, 10), { slippageBps: '0' }),
    data: loaded({
      [A]: series,
      ...Object.fromEntries(Object.entries(extra).map(([id, v]) => [id, closes(FROM, v)])),
    }),
  });
};

describe('Strategy Lab simplification (ADR 0049)', () => {
  it('"once per cycle" enters again in a second cycle after the first one closes', () => {
    const def = strategy(
      compare(close(), 'gt', constant('100')),
      [leg('buy')],
      compare(close(), 'gt', constant('110')),
      [leg('sell', { side: 'sell' })],
    );
    def.entry.trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
    // Entry stays true throughout; Exit is true once, on day 4.
    const r = run(def, [101, 101, 101, 111, 105, 105, 105]);
    expect(r.trades.map((t) => t.cycle)).toEqual([1, 2]);
  });

  it('fires a crossing on the bar it happens, with no confirmation', () => {
    const def = strategy(
      compare(close(), 'crosses_above', constant('100')),
      [leg('buy')],
      compare(close(), 'lt', constant('0')),
      [leg('sell', { side: 'sell' })],
    );
    const r = run(def, [99, 99, 101, 102, 103]);
    // Decided at the crossing close (day 3), filled at the next open (day 4).
    expect(r.fills[0]?.time).toBe(closes(FROM, [0, 0, 0, 0])[3]!.start);
  });

  it('counts the cooldown in bars: 2 bars between entries', () => {
    const def = strategy(
      compare(close(), 'gt', constant('100')),
      [leg('buy')],
      compare(close(), 'gt', constant('0')),
      [leg('sell', { side: 'sell' })],
    );
    def.entry.trigger = { mode: 'while_true', cooldownBars: 3, confirmationBars: 0 };
    def.execution.reentry = { mode: 'independent_cycles' };
    const r = run(
      def,
      Array.from({ length: 10 }, () => 101),
    );
    const entries = r.fills.filter((f) => f.side === 'buy').map((f) => f.time);
    const days = closes(
      FROM,
      Array.from({ length: 10 }, () => 0),
    ).map((b) => b.start);
    // Fires on evaluations 1, 4, 7 (and 10, filled after the run ends).
    expect(entries).toEqual([days[1], days[4], days[7]]);
  });

  it('exits a per-leg slot on the first bar its Exit condition is true, with no trigger', () => {
    const def = strategy(
      compare(close(), 'gt', constant('0')),
      [leg('buy')],
      compare(close(), 'gt', constant('105')),
      [leg('sell', { side: 'sell' })],
    );
    def.entry.condition.children = [];
    def.entry.orders[0]!.legCondition = {
      kind: 'group',
      id: 'lc',
      op: 'and',
      negate: false,
      children: [compare(close(), 'gt', constant('0'))],
    };
    delete def.exit.trigger;
    // The Exit condition is true from the first bar the position is held: an
    // "on transition" trigger would have waited for it to turn false first.
    const days = closes(FROM, [0, 0, 0, 0, 0]).map((b) => b.start);
    const r = run(def, [100, 106, 106, 106, 106]);
    // Bought at the open after the slot is chosen, sold at the next open, chosen again.
    expect(r.fills.map((f) => [f.time, f.side])).toEqual([
      [days[2], 'buy'],
      [days[3], 'sell'],
      [days[4], 'buy'],
    ]);
  });

  it('opens a cycle for a timed Entry leg only with "Allow timed entries without conditions" on', () => {
    const days = closes(FROM, [0, 0, 0, 0, 0]).map((b) => b.start);
    const def = strategy(
      compare(close(), 'lt', constant('0')),
      [leg('buy', { timing: { mode: 'exact', at: days[2]!, zone: 'UTC' } })],
      compare(close(), 'lt', constant('0')),
      [leg('sell', { side: 'sell' })],
    );
    expect(run(def, [100, 100, 100, 100, 100]).fills).toHaveLength(0);
    def.execution.timingOnly = true;
    expect(run(def, [100, 100, 100, 100, 100]).fills.filter((f) => f.side === 'buy')).toHaveLength(
      1,
    );
  });
});
