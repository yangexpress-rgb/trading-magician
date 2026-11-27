import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDefinition } from './defaults';
import type { SeriesResolver } from './evaluate';
import {
  decideDay,
  evaluateMachineCondition,
  machineView,
  replayMachine,
  rowTruth,
  type MachineView,
  type StateSwitch,
} from './machine-evaluate';
import {
  QQQ,
  RISK_OFF,
  S,
  TQQQ,
  dayResolver,
  machineContext,
  regimeWalk,
  walkDates,
  workedExample,
} from './machine-fixtures';
import {
  createMachineDefinition,
  fallbackStateId,
  machineDefinitionSchema,
  type MachineCondition,
  type MachineDefinition,
  type MachineRow,
} from './machine-schema';
import { validateMachine } from './machine-validate';
import {
  NotRulesDefinitionError,
  UnsupportedSchemaVersionError,
  canonicalJson,
  definitionForm,
  parseAnyDefinition,
  parseDefinition,
} from './serialize';

/** State-machine brief v1.3 §2, Phase P2a (ADR 0124): the form, its checks and the evaluator. */

const codes = (def: MachineDefinition) => {
  const r = validateMachine(def, machineContext());
  return { errors: r.errors.map((e) => e.code), warnings: r.warnings.map((w) => w.code) };
};
const clone = <T>(x: T): T => structuredClone(x);
const row = (def: MachineDefinition, id: string) =>
  def.machine.rows.find((r) => r.id === id) as MachineRow;

describe('the state-machine form (§2.5)', () => {
  it('parses the worked example unchanged, as its own form', () => {
    const doc = workedExample();
    const parsed = parseAnyDefinition(JSON.parse(JSON.stringify(doc)));
    expect(parsed.form).toBe('state_machine');
    expect(canonicalJson(parsed.definition)).toBe(canonicalJson(doc));
  });

  it('keeps rules-form documents on the rules path', () => {
    const rules = createDefinition();
    expect(definitionForm(rules)).toBe('rules');
    expect(parseAnyDefinition(rules).form).toBe('rules');
  });

  it('never reaches a reader of Entry and Exit', () => {
    expect(() => parseDefinition(workedExample())).toThrow(NotRulesDefinitionError);
  });

  it('never passes through the rules migrations (A1 pass-through)', () => {
    // A state machine carrying an old rules schemaVersion is still read as a
    // state machine, untouched: rules migrations 1 to 5 never see it. Any later
    // rules-form migration must keep this test passing.
    const base = workedExample();
    const parsed = parseAnyDefinition({ ...clone(base), schemaVersion: 1 });
    expect(parsed.form).toBe('state_machine');
    expect(canonicalJson(parsed.definition)).toBe(canonicalJson(base));
    // Its own version is checked, never migrated by the rules code.
    expect(() => parseAnyDefinition({ ...workedExample(), machineVersion: 2 })).toThrow(
      UnsupportedSchemaVersionError,
    );
  });

  it('a new state machine is a valid document with a fallback row to cash', () => {
    const def = createMachineDefinition();
    expect(machineDefinitionSchema.safeParse(def).success).toBe(true);
    expect(fallbackStateId(def.machine)).toBe(def.machine.states[1]?.id);
    expect(codes(def).errors).toEqual(['no_signal']);
  });

  it('refuses weights over 100%, a repeated target, and a trailing stop', () => {
    const over = clone(workedExample());
    over.machine.states[0]!.targets = [
      { instrumentId: QQQ, weightPct: '60' },
      { instrumentId: TQQQ, weightPct: '40.01' },
    ];
    expect(machineDefinitionSchema.safeParse(over).success).toBe(false);
    const full = clone(over);
    full.machine.states[0]!.targets[1]!.weightPct = '40';
    expect(machineDefinitionSchema.safeParse(full).success).toBe(true);
    const twice = clone(workedExample());
    twice.machine.states[0]!.targets = [
      { instrumentId: QQQ, weightPct: '10' },
      { instrumentId: QQQ, weightPct: '10' },
    ];
    expect(machineDefinitionSchema.safeParse(twice).success).toBe(false);
    const trailing = { ...workedExample(), risk: { trailingStopPct: '1' } };
    expect(machineDefinitionSchema.safeParse(trailing).success).toBe(false);
  });

  it('refuses the state operands with an offset, inside a statistic or a calculation (§2.1)', () => {
    const withSide = (left: unknown) => {
      const def = clone(workedExample()) as unknown as {
        machine: { rows: { condition?: { children: unknown[] } }[] };
      };
      def.machine.rows[0]!.condition!.children.push({
        kind: 'comparison',
        id: 'x1',
        left,
        operator: 'lt',
        right: { kind: 'constant', id: 'x2', value: '3' },
      });
      return machineDefinitionSchema.safeParse(def).success;
    };
    expect(withSide({ kind: 'days_in_state', id: 'd' })).toBe(true);
    expect(withSide({ kind: 'days_in_state', id: 'd', offset: 1 })).toBe(false);
    expect(
      withSide({
        kind: 'stat',
        id: 's',
        fn: 'STDDEV',
        period: 5,
        input: { kind: 'days_in_state', id: 'd' },
      }),
    ).toBe(false);
    expect(
      withSide({
        kind: 'calc',
        id: 'k',
        op: 'add',
        args: [
          { kind: 'days_in_state', id: 'd' },
          { kind: 'constant', id: 'c', value: '1' },
        ],
      }),
    ).toBe(false);
    // And a rules-form condition can't hold one at all.
    const rules = createDefinition();
    rules.entry.condition.children.push({
      kind: 'comparison',
      id: 'x',
      left: { kind: 'days_in_state', id: 'd' } as never,
      operator: 'lt',
      right: { kind: 'constant', id: 'c', value: '3' },
    });
    expect(() => parseDefinition(rules)).toThrow();
  });
});

describe('validation (§2)', () => {
  it('passes the worked example with no errors or warnings', () => {
    expect(codes(workedExample())).toEqual({ errors: [], warnings: [] });
  });

  it('needs an unconditional last row going to a state, and no unconditional row above it', () => {
    const stayLast = clone(workedExample());
    stayLast.machine.rows[13]!.outcome = { kind: 'stay' };
    expect(codes(stayLast).errors).toContain('no_fallback');
    const early = clone(workedExample());
    delete early.machine.rows[3]!.condition;
    expect(codes(early).errors).toContain('unconditional_row_not_last');
  });

  it('refuses unknown states and rows, and rows that reuse each other in a loop', () => {
    const def = clone(workedExample());
    row(def, 'r2').outcome = { kind: 'go', stateId: 'NOPE' };
    expect(codes(def).errors).toContain('unknown_state');
    const unknownRef = clone(workedExample());
    row(unknownRef, 'r7').condition!.children[0] = { kind: 'row_ref', id: 'q', rowId: 'r99' };
    expect(codes(unknownRef).errors).toContain('unknown_row');
    const loop = clone(workedExample());
    row(loop, 'r11').condition!.children.push({ kind: 'row_ref', id: 'q', rowId: 'r7' });
    expect(codes(loop).errors).toContain('row_ref_loop');
  });

  it('refuses a crossing or an availability check on days in state', () => {
    for (const operator of ['crosses_above', 'is_available'] as const) {
      const def = clone(workedExample());
      row(def, 'r1').condition!.children.push({
        kind: 'comparison',
        id: 'x',
        left: { kind: 'days_in_state', id: 'd' },
        operator,
        right: { kind: 'constant', id: 'c', value: '3' },
      });
      expect(codes(def).errors).toContain(
        operator === 'is_available' ? 'state_days_operator' : 'state_days_history',
      );
    }
  });

  it('reads daily bars of the signal instruments only, and no position values', () => {
    const base = workedExample().machine.rows[4]!.condition!.children[2] as unknown as {
      left: Record<string, unknown>;
    };
    const variants: [Record<string, unknown>, string][] = [
      [{ ...base.left, id: 'v1', interval: '5m' }, 'machine_daily_only'],
      [{ ...base.left, id: 'v2', instrumentId: TQQQ }, 'signal_not_listed'],
      [
        {
          kind: 'position',
          id: 'v3',
          instrumentId: QQQ,
          field: 'pnl',
          interval: '1d',
          adjustment: 'split_and_dividend',
          session: 'regular',
        },
        'position_in_machine',
      ],
      [
        { kind: 'metric', id: 'v4', metric: 'session.vwap', params: {}, instrumentId: QQQ },
        'machine_daily_only',
      ],
    ];
    for (const [left, code] of variants) {
      const def = clone(workedExample());
      row(def, 'r1').condition!.children.push({
        kind: 'comparison',
        id: `x${code}`,
        left: left as never,
        operator: 'gt',
        right: { kind: 'constant', id: `c${code}`, value: '1' },
      });
      expect(codes(def).errors).toContain(code);
    }
  });

  it('holds stocks and ETFs only, and warns when a limit is below the largest target', () => {
    const ctx = machineContext();
    const index = {
      ...ctx,
      instruments: new Map([
        ...ctx.instruments,
        [QQQ, { symbol: 'QQQ', assetClass: 'index', lotSize: '1' }],
      ]),
    };
    expect(validateMachine(workedExample(), index).errors.map((e) => e.code)).toContain(
      'target_not_tradable',
    );
    const low = clone(workedExample());
    low.risk.maxOrderPctEquity = '50';
    expect(codes(low).warnings).toEqual(['limit_below_target']);
  });

  it('warns about a state no row goes to', () => {
    const def = clone(workedExample());
    def.machine.states.push({ id: 'LONELY', name: 'Lonely', targets: [] });
    expect(codes(def).warnings).toEqual(['state_unreachable']);
  });
});

describe('days in state (§2.1)', () => {
  const start = { stateId: S.BEAR_CASH, on: '2025-02-24' };

  it('counts the entry day as day 1: entered Monday, 2 at Tuesday’s close', () => {
    const switches: StateSwitch[] = [
      { on: '2025-03-03', fromStateId: S.NORMAL, toStateId: S.DEFEND },
    ];
    expect(machineView(start, switches, '2025-03-03').daysInState).toBe(1);
    expect(machineView(start, switches, '2025-03-04').daysInState).toBe(2);
    // NYSE sessions: Friday to Monday is one session.
    expect(machineView(start, switches, '2025-03-10').daysInState).toBe(6);
  });

  it('counts across the risk-off set without restarting on moves within it', () => {
    const switches: StateSwitch[] = [
      { on: '2025-02-27', fromStateId: S.BEAR_CASH, toStateId: S.NORMAL },
      { on: '2025-03-03', fromStateId: S.NORMAL, toStateId: S.BEAR_CASH },
      { on: '2025-03-05', fromStateId: S.BEAR_CASH, toStateId: S.DEFEND },
    ];
    const v = machineView(start, switches, '2025-03-06');
    expect(v.current).toBe(S.DEFEND);
    expect(v.prior).toBe(S.BEAR_CASH);
    expect(v.daysInState).toBe(2);
    expect(v.daysInStates(RISK_OFF)).toBe(4); // Mar 3, 4, 5, 6
    expect(v.daysInStates([S.NORMAL])).toBe(0);
    // From the start, when the run has never left the set.
    expect(machineView(start, [], '2025-02-26').daysInStates(RISK_OFF)).toBe(3);
  });

  it('is derived from the switches, so a pause or missed pass changes nothing', () => {
    const switches: StateSwitch[] = [
      { on: '2025-03-03', fromStateId: S.BEAR_CASH, toStateId: S.DEFEND },
    ];
    // Evaluating only on Friday gives what evaluating every day would give on Friday.
    expect(machineView(start, switches, '2025-03-07').daysInStates(RISK_OFF)).toBe(10);
  });
});

/** A view of fixed values, for evaluator properties. */
const view = (current: string, prior?: string, days = 1): MachineView => ({
  current,
  prior,
  daysInState: days,
  daysInStates: () => days,
});
const noData: SeriesResolver = { value: () => undefined, isStale: () => false };

type T3 = 'T' | 'F' | 'U';
/** A comparison that is true, false or unknown whatever the market. */
const truthNode = (t: T3, id: string): MachineCondition =>
  t === 'U'
    ? {
        kind: 'comparison',
        id,
        left: {
          kind: 'market',
          id: `${id}m`,
          instrumentId: QQQ,
          field: 'close',
          interval: '1d',
          adjustment: 'split_and_dividend',
          session: 'regular',
          offset: 0,
        },
        operator: 'gt',
        right: { kind: 'constant', id: `${id}c`, value: '0' },
      }
    : {
        kind: 'comparison',
        id,
        left: { kind: 'constant', id: `${id}l`, value: t === 'T' ? '1' : '0' },
        operator: 'gt',
        right: { kind: 'constant', id: `${id}r`, value: '0' },
      };

describe('the evaluator (§2, §2.2)', () => {
  const states = ['A', 'B', 'C'];
  const arbRows = fc.array(
    fc.record({
      truth: fc.constantFrom<T3>('T', 'F', 'U'),
      go: fc.option(fc.constantFrom(...states)),
    }),
    { minLength: 0, maxLength: 8 },
  );

  it('the first true row decides; an unknown row above it makes the day a stay', () => {
    fc.assert(
      fc.property(arbRows, fc.constantFrom(...states), (spec, current) => {
        const rows: MachineRow[] = spec.map((s, i) => ({
          id: `r${i}`,
          condition: {
            kind: 'group',
            id: `g${i}`,
            op: 'and',
            negate: false,
            children: [truthNode(s.truth, `n${i}`)],
          },
          outcome: s.go ? { kind: 'go', stateId: s.go } : { kind: 'stay' },
        }));
        rows.push({ id: 'last', outcome: { kind: 'go', stateId: 'C' } });
        const machine = { states: states.map((id) => ({ id, name: id, targets: [] })), rows };
        const got = decideDay(machine, view(current), noData);

        // Reference model, written from the brief.
        const k = spec.findIndex((s) => s.truth !== 'F');
        const hit =
          k === -1
            ? { truth: 'T' as T3, go: 'C' as string | null, id: 'last' }
            : { ...spec[k]!, id: `r${k}` };
        if (hit.truth === 'U')
          expect(got).toEqual({ kind: 'stay', reason: 'unknown', rowId: hit.id });
        else if (!hit.go) expect(got).toEqual({ kind: 'stay', reason: 'row', rowId: hit.id });
        else if (hit.go === current)
          expect(got).toEqual({ kind: 'stay', reason: 'same_state', rowId: hit.id });
        else expect(got).toEqual({ kind: 'switch', rowId: hit.id, toStateId: hit.go });
      }),
    );
  });

  it('a row reference reads exactly that row’s rule, also inside OR and NOT', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<T3>('T', 'F', 'U'),
        fc.constantFrom<T3>('T', 'F', 'U'),
        fc.boolean(),
        (a, b, negate) => {
          const rowA: MachineRow = {
            id: 'a',
            condition: {
              kind: 'group',
              id: 'ga',
              op: 'and',
              negate: false,
              children: [truthNode(a, 'na')],
            },
            outcome: { kind: 'stay' },
          };
          const inline: MachineCondition = {
            kind: 'group',
            id: 'or1',
            op: 'or',
            negate,
            children: [truthNode(a, 'x'), truthNode(b, 'y')],
          };
          const byRef: MachineCondition = {
            kind: 'group',
            id: 'or2',
            op: 'or',
            negate,
            children: [{ kind: 'row_ref', id: 'ref', rowId: 'a' }, truthNode(b, 'z')],
          };
          const env = { view: view('A'), resolver: noData, rows: new Map([['a', rowA]]) };
          expect(evaluateMachineCondition(byRef, env)).toBe(evaluateMachineCondition(inline, env));
        },
      ),
    );
  });

  it('reads the current and prior state, and the counts', () => {
    const env = { view: view('B', 'A', 2), resolver: noData, rows: new Map() };
    const ev = (n: MachineCondition) => evaluateMachineCondition(n, env);
    expect(ev({ kind: 'state_is', id: 's', which: 'current', stateIds: ['A', 'B'] })).toBe(true);
    expect(ev({ kind: 'state_is', id: 's', which: 'prior', stateIds: ['B'] })).toBe(false);
    expect(
      evaluateMachineCondition(
        { kind: 'state_is', id: 's', which: 'prior', stateIds: ['A'] },
        { ...env, view: view('B') },
      ),
    ).toBe(false);
    const days = (op: 'lt' | 'gte', v: string): MachineCondition => ({
      kind: 'comparison',
      id: 'd',
      left: { kind: 'days_in_state', id: 'dd' },
      operator: op,
      right: { kind: 'constant', id: 'c', value: v },
    });
    expect(ev(days('lt', '3'))).toBe(true);
    expect(ev(days('gte', '3'))).toBe(false);
    expect(rowTruth({ id: 'x', outcome: { kind: 'stay' } }, env)).toBe(true);
  });
});

describe('the worked example on a walk (§4, §2.7)', () => {
  const N = 1500;
  // Seed 3 visits 10 of the 11 states, TOP_ESCAPE, DEFEND and the anti-V lock included.
  const days = regimeWalk(N, 3);
  const dates = walkDates(N);
  const at = dayResolver(days);
  const def = workedExample();
  const replay = replayMachine(def.machine, dates, at);

  it('visits most states, starting in the fallback', () => {
    expect(replay.startStateId).toBe(S.BEAR_CASH);
    const visited = new Set(replay.switches.map((s) => s.toStateId));
    expect(visited.size).toBeGreaterThanOrEqual(10);
    expect(replay.switches.length).toBeGreaterThan(20);
  });

  it('A5: no row wins before the longest window (MA200) is available', () => {
    const first = dates.indexOf(replay.switches[0]!.on);
    expect(first).toBeGreaterThanOrEqual(199);
    for (const step of replay.steps.slice(0, 199)) expect(step.decision.kind).toBe('stay');
  });

  it('HI_CASH goes back to HI only by the deviation escape, never by the chain (§4.1)', () => {
    // Rows 1 and 2 apply only when current is HI; row 4 (deviation over 20%,
    // within 5% of the high) is an ordinary row, so it may claim HI_CASH's day.
    const back = replay.switches.filter((s) => s.fromStateId === S.HI_CASH && s.toStateId === S.HI);
    for (const s of back)
      expect(replay.steps.find((st) => st.on === s.on)?.decision).toMatchObject({ rowId: 'r4' });
    const decidedBy = (rowId: string) =>
      replay.steps.filter((st) => 'rowId' in st.decision && st.decision.rowId === rowId);
    for (const st of [...decidedBy('r1'), ...decidedBy('r2')]) expect(st.current).toBe(S.HI);
  });

  it('the anti-V lock: risk-off goes to ATTACK or NORMAL only after 3 days in the set with MA20 rising', () => {
    const start = { stateId: replay.startStateId, on: dates[0]! };
    const index = new Map(dates.map((d, i) => [d, i]));
    const sessions = (a: string, b: string) => index.get(b)! - index.get(a)!;
    let unlocked = 0;
    replay.switches.forEach((s, k) => {
      if (!RISK_OFF.includes(s.fromStateId as never)) return;
      if (s.toStateId !== S.ATTACK && s.toStateId !== S.NORMAL) return;
      const v = machineView(start, replay.switches.slice(0, k), s.on, sessions);
      const i = index.get(s.on)!;
      const ma = (j: number) => days.slice(j - 19, j + 1).reduce((a, d) => a + d.close, 0) / 20;
      expect(v.daysInStates(RISK_OFF)).toBeGreaterThanOrEqual(3);
      expect(ma(i)).toBeGreaterThan(ma(i - 1));
      unlocked++;
    });
    expect(unlocked).toBeGreaterThan(0);
    // And the lock did hold on some days.
    expect(
      replay.steps.some(
        (s) => s.decision.kind === 'stay' && 'rowId' in s.decision && s.decision.rowId === 'r6',
      ),
    ).toBe(true);
  });

  it('a missing bar mid-run is a stay, never a lower row winning (§2.2)', () => {
    const switchDay = dates.indexOf(replay.switches[5]!.on);
    const gap = replayMachine(def.machine, dates, dayResolver(days, new Set([switchDay])));
    expect(gap.steps[switchDay]!.decision).toMatchObject({ kind: 'stay', reason: 'unknown' });
    expect(gap.steps.slice(0, switchDay)).toEqual(replay.steps.slice(0, switchDay));
  });

  it('A2: changing any bar after t never changes the path up to t', () => {
    for (const t of [400, 800, 1200]) {
      for (const seed of [3, 11]) {
        const future = regimeWalk(N - t - 1, seed + 100).map((d) => ({
          open: d.open * 4,
          close: d.close * 4,
          volume: d.volume * 30,
        }));
        const mutated = [...days.slice(0, t + 1), ...future];
        const other = replayMachine(def.machine, dates, dayResolver(mutated));
        expect(other.steps.slice(0, t + 1)).toEqual(replay.steps.slice(0, t + 1));
      }
    }
  });
});
