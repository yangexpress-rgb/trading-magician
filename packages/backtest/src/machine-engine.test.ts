import {
  DEFAULT_MACHINE_EXECUTION,
  DEFAULT_MACHINE_RISK,
  replayMachine,
  type Bar,
  type MachineDefinition,
  type MachineRow,
} from '@tm/domain';
import {
  dayResolver,
  QQQ,
  regimeWalk,
  S,
  TQQQ,
  walkDates,
  workedExample,
  type Day,
} from '@tm/domain/machine-fixtures';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { seriesKey, type InstrumentRef, type LoadedData } from './data';
import { DEFAULT_BACKTEST_INPUTS, type BacktestInputs } from './inputs';
import {
  COMPLETION_DAYS,
  MACHINE_ENGINE_VERSION,
  planMachineSeries,
  simulateMachine,
} from './machine-engine';
import type { BacktestResult } from './results';

/**
 * The state-machine back test (state-machine brief v1.4 §2.3–§2.7, §7 P2b;
 * ADR 0124): A4 rebalancing and completion, A5 warm-up, A3c synthetic paths,
 * and the engine's state path against the evaluator's replay.
 */

const SIG = '00000000-0000-4000-8000-000000000a03';
const key = (instrumentId: string) =>
  seriesKey({ instrumentId, interval: '1d', adjustment: 'split_and_dividend', session: 'regular' });

const instruments = new Map<string, InstrumentRef>([
  [QQQ, { symbol: 'QQQ', assetClass: 'etf', lotSize: '1' }],
  [TQQQ, { symbol: 'TQQQ', assetClass: 'etf', lotSize: '1' }],
  [SIG, { symbol: 'SIG', assetClass: 'etf', lotSize: '1' }],
]);

interface Px {
  open: number;
  close: number;
  volume?: number;
}

function toBars(days: readonly Px[], dates: readonly string[], skip = new Set<number>()): Bar[] {
  const out: Bar[] = [];
  days.forEach((d, i) => {
    if (skip.has(i)) return;
    out.push({
      start: `${dates[i]}T14:30:00.000Z`,
      end: `${dates[i]}T21:00:00.000Z`,
      open: new Decimal(d.open),
      high: new Decimal(Math.max(d.open, d.close)),
      low: new Decimal(Math.min(d.open, d.close)),
      close: new Decimal(d.close),
      volume: new Decimal(d.volume ?? 10_000_000),
    });
  });
  return out;
}

/** TQQQ as three times QQQ's daily move, from 50. */
function leveraged(days: readonly Day[]): Px[] {
  let close = 50;
  return days.map((d, i) => {
    const prev = i === 0 ? d.open : (days[i - 1] as Day).close;
    const open = close * (1 + 3 * (d.open / prev - 1));
    close = Math.max(0.5, open * (1 + 3 * (d.close / d.open - 1)));
    return { open: Math.round(open * 100) / 100, close: Math.round(close * 100) / 100 };
  });
}

const data = (series: [string, Bar[]][]): LoadedData => ({
  series: new Map(series.map(([id, bars]) => [key(id), bars])),
  dataVersions: ['test'],
  warnings: [],
});

const inputs = (from: string, to: string, extra: Partial<BacktestInputs> = {}): BacktestInputs => ({
  ...DEFAULT_BACKTEST_INPUTS,
  from,
  to,
  ...extra,
});

// ---------------------------------------------------------------------------
// A small machine on a signal-only instrument, so the held prices stay put.

let n = 0;
const uid = (p: string) => `${p}${++n}`;
const sigAtLeast = (v: number) => ({
  kind: 'group' as const,
  id: uid('g'),
  op: 'and' as const,
  negate: false,
  children: [
    {
      kind: 'comparison' as const,
      id: uid('c'),
      left: {
        kind: 'market' as const,
        id: uid('m'),
        instrumentId: SIG,
        field: 'close' as const,
        interval: '1d' as const,
        adjustment: 'split_and_dividend' as const,
        session: 'regular' as const,
        offset: 0,
      },
      operator: 'gte' as const,
      right: { kind: 'constant' as const, id: uid('k'), value: String(v) },
    },
  ],
});

/** SIG close picks the state: ≥200 FULL, ≥150 NEAR, ≥130 MIX2, ≥120 MIX, ≥110 LEV, else CASH. */
function small(risk: Partial<MachineDefinition['risk']> = {}): MachineDefinition {
  const row = (id: string, stateId: string, at?: number): MachineRow => ({
    id,
    outcome: { kind: 'go', stateId },
    ...(at === undefined ? {} : { condition: sigAtLeast(at) }),
  });
  return {
    form: 'state_machine',
    machineVersion: 1,
    trade: { kind: 'signals', instrumentIds: [SIG] },
    machine: {
      states: [
        { id: 'FULL', name: 'Full', targets: [{ instrumentId: QQQ, weightPct: '99' }] },
        { id: 'NEAR', name: 'Near', targets: [{ instrumentId: QQQ, weightPct: '96' }] },
        {
          id: 'MIX2',
          name: 'Mix 2',
          targets: [
            { instrumentId: QQQ, weightPct: '50.3' },
            { instrumentId: TQQQ, weightPct: '40' },
          ],
        },
        {
          id: 'MIX',
          name: 'Mix',
          targets: [
            { instrumentId: QQQ, weightPct: '50' },
            { instrumentId: TQQQ, weightPct: '49' },
          ],
        },
        { id: 'LEV', name: 'Leveraged', targets: [{ instrumentId: TQQQ, weightPct: '99' }] },
        { id: 'CASH', name: 'Cash', targets: [] },
      ],
      rows: [
        row('r1', 'FULL', 200),
        row('r2', 'NEAR', 150),
        row('r3', 'MIX2', 130),
        row('r4', 'MIX', 120),
        row('r5', 'LEV', 110),
        row('r6', 'CASH'),
      ],
    },
    execution: { ...DEFAULT_MACHINE_EXECUTION },
    risk: { ...DEFAULT_MACHINE_RISK, ...risk },
  };
}

/** Runs the small machine over a SIG script; QQQ at 100 and TQQQ at 50 unless overridden. */
function runSmall(
  sig: number[],
  opts: {
    qqq?: (i: number) => Partial<Px>;
    tqqq?: (i: number) => Partial<Px>;
    risk?: Partial<MachineDefinition['risk']>;
  } = {},
): { result: BacktestResult; dates: string[] } {
  const dates = walkDates(sig.length);
  const flat = (base: number, f?: (i: number) => Partial<Px>) =>
    sig.map((_, i) => ({ open: base, close: base, ...f?.(i) }));
  const result = simulateMachine({
    definition: small(opts.risk),
    instruments,
    inputs: inputs(dates[0] as string, dates.at(-1) as string, { slippageBps: '0' }),
    data: data([
      [
        SIG,
        toBars(
          sig.map((v) => ({ open: v, close: v })),
          dates,
        ),
      ],
      [QQQ, toBars(flat(100, opts.qqq), dates)],
      [TQQQ, toBars(flat(50, opts.tqqq), dates)],
    ]),
  });
  return { result, dates };
}

const script = (...parts: [number, number][]) =>
  parts.flatMap(([v, count]) => Array(count).fill(v));
const report = (r: BacktestResult) => {
  if (!r.machine) throw new Error('no machine report');
  return r.machine;
};

describe('state-machine back test: rebalancing (A4)', () => {
  it('moves to a state at the next open, sells before buys, buys from the cash the sells leave', () => {
    const { result, dates } = runSmall(script([0, 5], [200, 10], [120, 10]));
    const m = report(result);
    const [full, mix] = m.transitions;
    expect(full).toMatchObject({
      kind: 'switch',
      on: dates[5],
      toStateId: 'FULL',
      outcome: 'done',
    });
    expect(full?.completedOn).toBe(dates[6]);
    // FULL → MIX: sell QQQ, buy TQQQ, both at day 16's open, the sell first.
    expect(mix).toMatchObject({ toStateId: 'MIX', outcome: 'done', completedOn: dates[16] });
    const legs = result.orders?.filter((o) => o.cycle === mix?.index) ?? [];
    expect(legs.map((o) => `${o.side} ${o.symbol}`)).toEqual(['sell QQQ', 'buy TQQQ']);
    expect(legs.every((o) => o.outcome === 'filled')).toBe(true);
    // Never short of cash, never negative holdings: every buy was paid from cash on hand.
    for (const p of result.equity) expect(Number(p.cash)).toBeGreaterThanOrEqual(0);
    const last = result.equity.at(-1);
    expect(Number(last?.cash)).toBeLessThan(0.02 * Number(last?.equity));
    expect(result.engineVersion).toBe(MACHINE_ENGINE_VERSION);
    expect(result.trades).toEqual([]);
  });

  it('switches with no orders when every leg is under 5% of equity, complete at once', () => {
    const { result, dates } = runSmall(script([0, 5], [200, 5], [150, 5]));
    const near = report(result).transitions.find((t) => t.toStateId === 'NEAR');
    expect(near).toMatchObject({
      outcome: 'switched_no_orders',
      orders: 0,
      completedOn: dates[10],
    });
    expect(result.orders?.some((o) => o.cycle === near?.index)).toBe(false);
    expect(report(result).finalStateId).toBe('NEAR');
  });

  it('skips a leg under 0.5% of equity while the others trade', () => {
    const { result } = runSmall(script([0, 3], [120, 5], [130, 5]));
    const mix2 = report(result).transitions.find((t) => t.toStateId === 'MIX2');
    expect(mix2?.outcome).toBe('done');
    // QQQ moves 50% → 50.3% (0.3%): no order; TQQQ 49% → 40%: sold.
    const legs = result.orders?.filter((o) => o.cycle === mix2?.index) ?? [];
    expect(legs.map((o) => `${o.side} ${o.symbol}`)).toEqual(['sell TQQQ']);
  });

  it('completes an interrupted transition on a later close, then stops trading (§2.4)', () => {
    // Day 4's open (the fill) trades little TQQQ: the 10% volume cap leaves the buy partial.
    const { result, dates } = runSmall(script([0, 3], [110, 12]), {
      tqqq: (i) => (i === 4 ? { volume: 5_000 } : {}),
    });
    const lev = report(result).transitions[0];
    expect(lev).toMatchObject({ toStateId: 'LEV', outcome: 'done', attempts: 2 });
    expect(lev?.completedOn).toBe(dates[5]);
    const orders = result.orders ?? [];
    expect(orders.map((o) => o.outcome)).toEqual(['partial', 'filled']);
    // Never drift repair: nothing after it's done, though the run goes on 9 more days.
    expect(new Set(result.fills.map((f) => f.time))).toEqual(
      new Set([`${dates[4]}T14:30:00.000Z`, `${dates[5]}T14:30:00.000Z`]),
    );
  });

  it(`marks a transition stuck after ${COMPLETION_DAYS} trading days and stops trying`, () => {
    const { result, dates } = runSmall(script([0, 3], [110, 20]), {
      tqqq: (i) => (i >= 4 ? { volume: 1_000 } : {}),
    });
    const lev = report(result).transitions[0];
    expect(lev?.outcome).toBe('stuck');
    expect(lev?.attempts).toBe(COMPLETION_DAYS + 1);
    const lastFill = result.fills.at(-1)?.time.slice(0, 10);
    expect(lastFill).toBe(dates[3 + COMPLETION_DAYS + 1]);
    expect(result.warnings.map((w) => w.code)).toContain('machine_stuck');
  });

  it('marks an incomplete transition superseded when the state switches again', () => {
    const { result, dates } = runSmall(script([0, 3], [110, 3], [200, 6]), {
      tqqq: (i) => (i >= 4 ? { volume: 1_000 } : {}),
    });
    const [lev, full] = report(result).transitions;
    expect(lev?.outcome).toBe('superseded');
    expect(full).toMatchObject({ toStateId: 'FULL', on: dates[6], outcome: 'done' });
    // FULL sells the TQQQ bought so far before buying QQQ.
    const legs = result.orders?.filter((o) => o.cycle === full?.index) ?? [];
    expect(legs[0]).toMatchObject({ side: 'sell', symbol: 'TQQQ' });
  });

  it('cancels an order outside the price collar and fills it on a later attempt', () => {
    // Day 4 opens 8% above day 3's close: outside the 5% collar.
    const { result, dates } = runSmall(script([0, 3], [200, 8]), {
      qqq: (i) => (i === 4 ? { open: 108, close: 108 } : i > 4 ? { open: 108, close: 108 } : {}),
    });
    const full = report(result).transitions[0];
    expect(result.orders?.[0]).toMatchObject({ outcome: 'canceled', reason: 'price_collar' });
    expect(full).toMatchObject({ outcome: 'done', completedOn: dates[5], attempts: 2 });
  });

  it('skips rebalance buys on a drawdown halt but still sells', () => {
    // FULL, then QQQ falls 30% (past a 20% drawdown halt) and the state moves to MIX.
    const { result } = runSmall(script([0, 3], [200, 4], [120, 4]), {
      qqq: (i) => (i >= 5 ? { open: 70, close: 70 } : {}),
      risk: { maxDrawdownPct: '20' },
    });
    const mix = report(result).transitions.find((t) => t.toStateId === 'MIX');
    const legs = result.orders?.filter((o) => o.cycle === mix?.index) ?? [];
    expect(legs.some((o) => o.side === 'sell' && o.outcome === 'filled')).toBe(true);
    expect(legs.filter((o) => o.side === 'buy').every((o) => o.reason === 'drawdown')).toBe(true);
  });

  it('stores time and return in each state, the stays covering every run day', () => {
    const { result, dates } = runSmall(script([0, 5], [200, 10], [120, 10]));
    const stays = report(result).stays;
    expect(stays.map((s) => s.stateId)).toEqual(['CASH', 'FULL', 'MIX']);
    expect(stays.at(-1)).toMatchObject({ ongoing: true, to: dates.at(-1) });
    expect(stays[0]?.returnPct).toBe('0');
    expect(report(result).notApplicable).toContain('winRatePct');
  });
});

// ---------------------------------------------------------------------------
// The worked example (§4) through the engine.

const WALK = 1500;
const walk = regimeWalk(WALK, 3);
const walkDays = walkDates(WALK);
const walkData = (skipQqq = new Set<number>()) =>
  data([
    [QQQ, toBars(walk, walkDays, skipQqq)],
    [TQQQ, toBars(leveraged(walk), walkDays)],
  ]);

describe('state-machine back test: the worked example', () => {
  const from = walkDays[400] as string;
  const run = simulateMachine({
    definition: workedExample(),
    instruments,
    inputs: inputs(from, walkDays.at(-1) as string),
    data: walkData(),
  });
  const m = report(run);

  it("follows the evaluator's replay exactly, from the first loaded bar (§2.9)", () => {
    const resolverAt = dayResolver(walk);
    const replay = replayMachine(workedExample().machine, walkDays, resolverAt);
    expect(m.replayedFrom).toBe(walkDays[0]);
    expect(m.startStateId).toBe(replay.steps[400]?.current);
    const switches = m.transitions
      .filter((t) => t.kind === 'switch')
      .map((t) => [t.on, t.fromStateId, t.toStateId]);
    const expected = replay.switches
      .filter((s) => s.on >= from)
      .map((s) => [s.on, s.fromStateId, s.toStateId]);
    expect(switches).toEqual(expected);
    expect(m.finalStateId).toBe(replay.finalStateId);
  }, 60_000);

  it('starts holding the replayed state, and never trades outside a transition', () => {
    const first = m.transitions[0];
    if (m.startStateId !== S.BEAR_CASH && m.startStateId !== S.HI_CASH)
      expect(first).toMatchObject({ kind: 'start', on: from, toStateId: m.startStateId });
    const cycles = new Set(m.transitions.map((t) => t.index));
    for (const f of run.fills) expect(cycles.has(f.cycle)).toBe(true);
    for (const p of run.equity) expect(Number(p.cash)).toBeGreaterThanOrEqual(0);
  });

  it('records the winning row and its checks as the Why lines (§2.6)', () => {
    for (const t of m.transitions.filter((x) => x.kind === 'switch')) {
      expect(t.rowId).toMatch(/^r\d+$/);
      if (t.rowId !== 'r16') expect(t.why.length).toBeGreaterThan(0);
    }
  });

  it('visits the risk-off and despair states on the synthetic path (A3c)', () => {
    const visited = new Set(m.stays.map((s) => s.stateId));
    for (const id of [
      S.TOP_ESCAPE,
      S.DESPAIR,
      S.DESPAIR_HV,
      S.ATTACK,
      S.NORMAL,
      S.HI,
      S.HI_CASH,
      S.BEAR_CASH,
    ])
      expect(visited, id).toContain(id);
    expect(m.stays.reduce((a, s) => a + s.sessions, 0)).toBe(WALK - 400);
  });

  it('holds TOP_ESCAPE through the anti-V lock: its first days stay put (row 8)', () => {
    const switches = m.transitions.filter((t) => t.kind === 'switch');
    const into = switches.filter((t) => t.toStateId === S.TOP_ESCAPE);
    expect(into.length).toBeGreaterThan(0);
    // No switch out of the risk-off set to ATTACK or NORMAL within its first 3 days.
    const at = new Map(walkDays.map((d, i) => [d, i]));
    for (const t of into) {
      const next = switches.find((s) => s.on > t.on);
      if (next && (next.toStateId === S.ATTACK || next.toStateId === S.NORMAL))
        expect((at.get(next.on) ?? 0) - (at.get(t.on) ?? 0)).toBeGreaterThanOrEqual(2);
    }
  });

  it('stays on a day with no QQQ bar: unknown means stay, and no order is planned (§2.2)', () => {
    const gap = 900;
    const withGap = simulateMachine({
      definition: workedExample(),
      instruments,
      inputs: inputs(from, walkDays.at(-1) as string),
      data: walkData(new Set([gap])),
    });
    const gm = report(withGap);
    expect(gm.transitions.some((t) => t.on === walkDays[gap])).toBe(false);
    expect(withGap.orders?.some((o) => o.decidedAt?.startsWith(walkDays[gap] as string))).toBe(
      false,
    );
  }, 60_000);
});

describe('state-machine back test: warm-up (A5)', () => {
  it('stays in the fallback state with no orders until MA200 has its bars', () => {
    const run = simulateMachine({
      definition: workedExample(),
      instruments,
      inputs: inputs(walkDays[0] as string, walkDays[400] as string),
      data: data([
        [QQQ, toBars(walk.slice(0, 401), walkDays)],
        [TQQQ, toBars(leveraged(walk).slice(0, 401), walkDays)],
      ]),
    });
    const m = report(run);
    expect(m.startStateId).toBe(S.BEAR_CASH);
    const firstFill = run.fills[0]?.time.slice(0, 10) ?? '9999';
    expect(firstFill > (walkDays[199] as string)).toBe(true);
    expect(m.transitions.every((t) => t.on >= (walkDays[199] as string))).toBe(true);
  });
});

describe('state-machine series plan', () => {
  it('loads all-history daily QQQ for the signals and daily closes of every target', () => {
    const plans = planMachineSeries(workedExample(), inputs('2025-01-02', '2025-06-30'));
    const qqq = plans.find((p) => p.spec.instrumentId === QQQ);
    const tqqq = plans.find((p) => p.spec.instrumentId === TQQQ);
    expect(qqq?.spec).toMatchObject({ interval: '1d', adjustment: 'split_and_dividend' });
    expect(qqq?.bars).toBeGreaterThanOrEqual(5040);
    expect(tqqq?.spec.interval).toBe('1d');
    expect(plans).toHaveLength(2);
  });
});
