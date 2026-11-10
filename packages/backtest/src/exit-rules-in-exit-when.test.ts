import {
  OPTION_SIGNAL_FIELDS,
  parseDefinition,
  type ExitRule,
  type OptionSignal,
  type OptionSignalValues,
  type StrategyDefinition,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { riskAtrTrend, SPY, spyBars } from './fixtures/spy-strategies';
import { inputs, loaded } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * The holding-period exit, the ATR stop and the expected-move exit read as
 * Exit when conditions (N221, ADR 0076): a saved rule converts on read and
 * exits on exactly the same closes as the rule did.
 */

const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);
const bars = spyBars();
const dates = bars.map((b) => b.start.slice(0, 10));

function signals(move = 0.02): Map<string, OptionSignal[]> {
  const nulls = Object.fromEntries(
    OPTION_SIGNAL_FIELDS.map((f) => [f, null]),
  ) as OptionSignalValues;
  return new Map([
    [
      SPY,
      dates.map((asOfDate, i) => ({
        asOfDate,
        values: {
          ...nulls,
          expected_move_5d_pct: move + (i % 5) * 0.002,
          expected_move_1d_pct: move / 2,
        },
        source: 'recorded' as const,
        ivHistoryDays: 252,
      })),
    ],
  ]);
}

const run = (def: StrategyDefinition) => {
  const data = loaded({ [SPY]: bars });
  data.options = signals();
  return simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-11-01', '2025-06-30'),
    data,
  });
};

/** The saved form: schema 4, with `rules`, and an Exit that fires on any check it holds. */
function saved(rules: ExitRule[], keepCondition = true): Record<string, unknown> {
  const def = riskAtrTrend();
  def.exit.rules = rules;
  if (!keepCondition) def.exit.condition.children = [];
  def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
  return { ...JSON.parse(JSON.stringify(def)), schemaVersion: 4 } as Record<string, unknown>;
}

const fills = (r: ReturnType<typeof run>) =>
  r.fills.map((f) => [f.time, f.side, f.quantity, f.price]);

function sameExits(doc: Record<string, unknown>, reason: string) {
  const asCondition = parseDefinition(doc);
  expect(asCondition.exit.rules ?? []).toEqual([]);
  // The rule as it ran before: the same strategy, rule kept, read as schema 5.
  const asRule = parseDefinition({ ...doc, schemaVersion: 5 });
  expect(asRule.exit.rules?.length).toBeGreaterThan(0);
  const a = run(asRule);
  const b = run(asCondition);
  expect(a.trades.filter((t) => t.exitReason === reason).length).toBeGreaterThan(0);
  expect(fills(b)).toEqual(fills(a));
  expect(b.trades.some((t) => t.exitReason === reason)).toBe(false);
}

describe('exit rules read as Exit when conditions (N221, ADR 0076)', () => {
  it('the holding-period exit: "Trading days held ≥ N"', () => {
    sameExits(saved([{ kind: 'timeStop', id: 'ts', barsHeld: 3 }]), 'time_stop');
  });

  it('the ATR stop: "Below entry, in ATRs at entry > multiple"', () => {
    sameExits(
      saved([{ kind: 'atrStop', id: 'a', override: { atrPeriod: 14, atrMultiple: '0.5' } }], false),
      'atr_stop',
    );
    // With no override it reads the Entry's risk distance.
    const doc = parseDefinition(saved([{ kind: 'atrStop', id: 'a' }]));
    expect(JSON.stringify(doc.exit.condition)).toContain('"period":20');
  });

  it('the expected-move exit, for a gain, a loss or either', () => {
    for (const side of ['either', 'gain', 'loss'] as const)
      sameExits(
        saved([{ kind: 'expectedMove', id: 'em', horizon: 5, multiple: '0.5', side }], false),
        'expected_move',
      );
  });

  it('all three at once, with the trailing stop from schema 3', () => {
    const doc = saved([
      { kind: 'timeStop', id: 'ts', barsHeld: 8 },
      { kind: 'atrStop', id: 'a', override: { atrPeriod: 14, atrMultiple: '1' } },
      { kind: 'expectedMove', id: 'em', horizon: 1, multiple: '1', side: 'either' },
    ]);
    const asCondition = parseDefinition(doc);
    const asRule = parseDefinition({ ...doc, schemaVersion: 5 });
    expect(fills(run(asCondition))).toEqual(fills(run(asRule)));
  });
});
