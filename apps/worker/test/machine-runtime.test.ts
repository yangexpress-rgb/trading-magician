import {
  DEFAULT_BACKTEST_INPUTS,
  loadData,
  planMachineSeries,
  simulateMachine,
  type InstrumentRef,
} from '@tm/backtest';
import {
  claimRuntimes,
  confirmMachineStart,
  createStrategy,
  eq,
  getBacktest,
  getStrategy,
  listNotifications,
  listTransitions,
  pauseRuntime,
  provisionWorkspace,
  resumeRuntime,
  schema,
  startBacktest,
  startStrategy,
  updateStrategy,
  validateStoredStrategy,
  withTenant,
  type MachineRunState,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  DEFAULT_MACHINE_EXECUTION,
  DEFAULT_MACHINE_RISK,
  nyDate,
  type MachineDefinition,
} from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';
import { createRuntimeCaches, runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';

/**
 * A state machine on paper (state-machine brief v1.4 §2.3–§2.4, §2.8, §2.9;
 * ADR 0124 P3a): the Start replay, the confirmation, the Start rebalance at
 * the open, a switch that sells first and buys from the cash left, no drift
 * repair, a paused run that keeps deciding, the shared-account warning, and
 * A6: the paper path equals the back test's.
 */

let t: TestDatabase;
let userId: string;
let demoA: string;
let demoB: string;
let account: string;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);

/** Test hook: DEMO-A daily closes replaced, by session date, to force a switch. */
const dailyCloses = new Map<string, string>();
let clock = 0;
const caches = createRuntimeCaches(async () => ({ ids: [], warnings: [] }));

const history = (now: () => Date) => {
  const demo = createDemoHistoryProvider({ now });
  return {
    ...demo,
    getBars: async (req: Parameters<typeof demo.getBars>[0]) => {
      const series = await demo.getBars(req);
      if (req.interval !== '1d' || req.instrumentId !== demoA || dailyCloses.size === 0)
        return series;
      return {
        ...series,
        bars: series.bars.map((b) => {
          const close = dailyCloses.get(nyDate(b.end));
          return close === undefined ? b : { ...b, close: new Decimal(close) };
        }),
      };
    },
  };
};

const options = (): RuntimeWorkerOptions => ({
  db: t.app.db,
  caches,
  workerId: 'machine-worker',
  history,
  quotes: (now) => createDemoLiveFeed({ now }),
  now: () => new Date(clock),
  logger: quiet,
});

async function pass() {
  const claimed = await claimRuntimes(t.app.db, 'machine-worker', { leaseSeconds: 30, limit: 10 });
  for (const c of claimed) await runRuntimePass(options(), c.runtimeId, c.userId);
  return claimed.length;
}

/**
 * DEMO-A's daily close against its 20-day average picks the state: 3% or more
 * below it is DEFENSIVE (half DEMO-B), held for at least 3 days by the stay
 * row; otherwise the fallback, INVESTED (DEMO-A 99%).
 */
function machine(): MachineDefinition {
  const g = (id: string, ...children: unknown[]) => ({
    kind: 'group' as const,
    id,
    op: 'and' as const,
    negate: false,
    children: children as never[],
  });
  return {
    form: 'state_machine',
    machineVersion: 1,
    trade: { kind: 'signals', instrumentIds: [demoA] },
    machine: {
      states: [
        { id: 'INVESTED', name: 'Invested', targets: [{ instrumentId: demoA, weightPct: '99' }] },
        { id: 'DEFENSIVE', name: 'Defensive', targets: [{ instrumentId: demoB, weightPct: '50' }] },
      ],
      rows: [
        {
          id: 'r1',
          outcome: { kind: 'go', stateId: 'DEFENSIVE' },
          condition: g('g1', {
            kind: 'comparison',
            id: 'c1',
            left: {
              kind: 'metric',
              id: 'm1',
              metric: 'ma_distance',
              params: { period: 20 },
              instrumentId: demoA,
            },
            operator: 'lte',
            right: { kind: 'constant', id: 'k1', value: '-0.03' },
          }),
        },
        {
          id: 'r2',
          outcome: { kind: 'stay' },
          condition: g(
            'g2',
            { kind: 'state_is', id: 's2', which: 'current', stateIds: ['DEFENSIVE'] },
            {
              kind: 'comparison',
              id: 'c2',
              left: { kind: 'days_in_state', id: 'd2' },
              operator: 'lt',
              right: { kind: 'constant', id: 'k2', value: '3' },
            },
          ),
        },
        { id: 'r3', outcome: { kind: 'go', stateId: 'INVESTED' } },
      ],
    },
    execution: { ...DEFAULT_MACHINE_EXECUTION },
    risk: { ...DEFAULT_MACHINE_RISK },
  };
}

async function startMachine(name: string, def = machine(), startingCapital?: string) {
  return asUser(async (tx) => {
    let s = await createStrategy(tx, userId, { name, definition: def });
    s = await updateStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      status: 'under_testing',
    });
    const { validation } = await validateStoredStrategy(tx, s.id, account);
    expect(validation.errors).toEqual([]);
    s = await startStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      confirmed: true,
      acknowledgedWarnings: validation.warnings.map((w) => w.code),
      ...(startingCapital ? { startingCapital } : {}),
    });
    const [runtime] = await tx
      .select()
      .from(schema.strategyRuntimes)
      .where(eq(schema.strategyRuntimes.strategyId, s.id));
    return { strategy: s, runtimeId: runtime!.id };
  });
}

const runState = async (runtimeId: string) =>
  (
    (
      await asUser((tx) =>
        tx
          .select({ state: schema.strategyRuntimes.state })
          .from(schema.strategyRuntimes)
          .where(eq(schema.strategyRuntimes.id, runtimeId)),
      )
    )[0]!.state as { machine?: MachineRunState }
  ).machine;

const orders = (runtimeId: string) =>
  asUser((tx) =>
    tx
      .select({
        phase: schema.orderIntents.phase,
        label: schema.orderIntents.legLabel,
        direction: schema.orderIntents.direction,
        quantity: schema.orderIntents.quantity,
        instrumentId: schema.orderIntents.instrumentId,
        state: schema.brokerOrders.state,
        cycleId: schema.orderIntents.cycleId,
        createdAt: schema.orderIntents.createdAt,
      })
      .from(schema.orderIntents)
      .innerJoin(schema.brokerOrders, eq(schema.brokerOrders.intentId, schema.orderIntents.id))
      .where(eq(schema.orderIntents.runtimeId, runtimeId))
      .orderBy(schema.orderIntents.createdAt),
  );

const stopAll = () =>
  t.ownerSql`update strategy_runtime set status = 'stopped', stopped_at = now() where status <> 'stopped'`;

/** New York 16:30 on a session date: after its daily bar closed. */
const afterClose = (date: string) => Date.parse(`${date}T20:30:00Z`);
/** New York 9:35 on a session date. */
const afterOpen = (date: string) => Date.parse(`${date}T13:35:00Z`);

beforeAll(async () => {
  t = await createTestDatabase();
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Machine', email: 'machine@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Machine' });
  await t.owner.db.update(schema.entitlements).set({ overrides: { activeStrategies: 100 } });
  const rows = await t.owner.db.select().from(schema.instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  demoB = rows.find((r) => r.symbol === 'DEMO-B')!.id;
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('state machine on paper (ADR 0124 P3a)', () => {
  it('saves and reads back as a state machine, with a carrier for the rules readers', async () => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Saved', definition: machine() }),
    );
    expect(s.form).toBe('state_machine');
    expect(s.machine?.machine.states.map((x) => x.id)).toEqual(['INVESTED', 'DEFENSIVE']);
    expect(s.definition.entry.orders).toEqual([]);
    expect(s.labNumber).toMatch(/-SD$/);
    // A rules document is never saved over a state machine.
    await expect(
      asUser((tx) =>
        updateStrategy(tx, userId, s.id, { rowVersion: s.rowVersion, definition: s.definition }),
      ),
    ).rejects.toThrow(/state-machine strategy/);
    const again = await asUser((tx) => getStrategy(tx, s.id));
    expect(again.machine).toEqual(s.machine);
  });

  it('replays at Start with no orders, then trades only once confirmed (§2.9)', async () => {
    clock = afterClose('2026-10-06');
    const { runtimeId } = await startMachine('Replay');
    expect(await pass()).toBe(1);
    const m = await runState(runtimeId);
    expect(m?.start.on).toBe('2015-01-02');
    expect(m?.lastDecidedOn).toBe('2026-10-06');
    expect(m?.proposal?.stateId).toBeDefined();
    expect(await orders(runtimeId)).toEqual([]);
    const notes = await asUser((tx) => listNotifications(tx, { limit: 50 }));
    expect(notes.notifications.some((n) => n.title.includes('replay done'))).toBe(true);

    // A6: the replayed path is the back test's path over the same bars.
    const def = machine();
    const inputs = {
      interval: '1d' as const,
      adjustment: 'split_and_dividend' as const,
      initialCapital: '100000',
      slippageBps: '0',
      commissionPerShare: '0',
      commissionMin: '0',
      maxVolumePct: '100',
      borrowRatePct: '0',
      from: '2015-01-02',
      to: '2026-10-06',
    };
    const refs = new Map<string, InstrumentRef>([
      [demoA, { symbol: 'DEMO-A', assetClass: 'etf', lotSize: '1' }],
      [demoB, { symbol: 'DEMO-B', assetClass: 'etf', lotSize: '1' }],
    ]);
    const data = await loadData(
      history(() => new Date(clock)),
      planMachineSeries(def, inputs),
      refs,
    );
    const bt = simulateMachine({ definition: def, instruments: refs, inputs, data });
    const btSwitches = bt
      .machine!.transitions.filter((x) => x.kind === 'switch')
      .map((x) => [x.on, x.fromStateId, x.toStateId]);
    expect(m!.switches.map((s) => [s.on, s.fromStateId, s.toStateId])).toEqual(btSwitches);
    expect(btSwitches.length).toBeGreaterThan(5);
    expect(m!.proposal!.stateId).toBe(bt.machine!.finalStateId);

    // Confirmed: the Start rebalance is placed, held for the open by the collar.
    await asUser((tx) => confirmMachineStart(tx, runtimeId, new Date(clock)));
    await pass();
    let o = await orders(runtimeId);
    expect(o.length).toBeGreaterThan(0);
    expect(o.every((x) => x.direction === 'buy' && x.state === 'ready')).toBe(true);
    const [start] = await asUser((tx) => listTransitions(tx, runtimeId));
    expect(start).toMatchObject({ seq: 1, kind: 'start', outcome: 'rebalancing' });

    // At the open it goes out and fills; then the transition is done.
    clock = afterOpen('2026-10-07');
    await pass();
    clock += 5_000;
    await pass();
    clock += 5_000;
    await pass();
    o = await orders(runtimeId);
    expect(o.every((x) => x.state === 'filled')).toBe(true);
    const [done] = await asUser((tx) => listTransitions(tx, runtimeId));
    expect(done!.outcome).toBe('done');
    expect(done!.completedOn).toBe('2026-10-07');

    // No drift repair: later closes in the same state place nothing.
    const before = o.length;
    for (const d of ['2026-10-07', '2026-10-08']) {
      clock = afterClose(d);
      await pass();
    }
    const m2 = await runState(runtimeId);
    if (m2!.switches.length === m!.switches.length)
      expect(await orders(runtimeId)).toHaveLength(before);
    await stopAll();
  }, 120_000);

  it('on a switch sells first, then buys from the cash the sells left (§2.3)', async () => {
    clock = afterClose('2026-10-06');
    const { runtimeId } = await startMachine('Switch');
    await pass();
    const m = await runState(runtimeId);
    await asUser((tx) => confirmMachineStart(tx, runtimeId, new Date(clock)));
    await pass();
    clock = afterOpen('2026-10-07');
    for (let i = 0; i < 3; i++) {
      await pass();
      clock += 5_000;
    }
    const startState = m!.proposal!.stateId;
    // Force INVESTED → DEFENSIVE at the close of 2026-10-08: DEMO-A 20% down.
    if (startState !== 'INVESTED') return;
    dailyCloses.set('2026-10-08', '1');
    clock = afterClose('2026-10-08');
    await pass();
    let o = await orders(runtimeId);
    const sells = o.filter((x) => x.direction === 'sell');
    expect(sells).toHaveLength(1);
    expect(sells[0]).toMatchObject({ instrumentId: demoA, phase: 'exit' });
    expect(o.filter((x) => x.direction === 'buy' && x.instrumentId === demoB)).toHaveLength(0);
    const transitions = await asUser((tx) => listTransitions(tx, runtimeId));
    expect(transitions.at(-1)).toMatchObject({
      kind: 'switch',
      fromStateId: 'INVESTED',
      toStateId: 'DEFENSIVE',
      rowId: 'r1',
      outcome: 'rebalancing',
    });
    expect(transitions.at(-1)!.why.length).toBeGreaterThan(0);

    // The sell fills at the open; only then does the buy go, sized from that cash.
    clock = afterOpen('2026-10-09');
    for (let i = 0; i < 4; i++) {
      await pass();
      clock += 5_000;
    }
    o = await orders(runtimeId);
    const buyB = o.filter((x) => x.direction === 'buy' && x.instrumentId === demoB);
    expect(buyB).toHaveLength(1);
    expect(o.find((x) => x.direction === 'sell')!.createdAt < buyB[0]!.createdAt).toBe(true);
    expect(o.every((x) => x.state === 'filled')).toBe(true);
    expect((await asUser((tx) => listTransitions(tx, runtimeId))).at(-1)!.outcome).toBe('done');
    dailyCloses.clear();
    await stopAll();
  }, 120_000);

  it("sizes the Start rebalance from the run's own starting capital (N400)", async () => {
    const startBuys = async (capital?: string) => {
      clock = afterClose('2026-10-06');
      const { runtimeId } = await startMachine(
        `Capital ${capital ?? 'default'}`,
        machine(),
        capital,
      );
      await pass();
      await asUser((tx) => confirmMachineStart(tx, runtimeId, new Date(clock)));
      await pass();
      const [row] = await asUser((tx) =>
        tx
          .select({ startingCapital: schema.strategyRuntimes.startingCapital })
          .from(schema.strategyRuntimes)
          .where(eq(schema.strategyRuntimes.id, runtimeId)),
      );
      const quantity = (await orders(runtimeId))
        .filter((o) => o.direction === 'buy')
        .reduce((sum, o) => sum + Number(o.quantity), 0);
      await stopAll();
      return { stored: row!.startingCapital, quantity };
    };
    const small = await startBuys();
    const large = await startBuys('50000');
    // Start's default is $10,000; the amount chosen is kept on the run.
    expect(small.stored).toBe('10000');
    expect(large.stored).toBe('50000');
    expect(small.quantity).toBeGreaterThan(0);
    // Same state, same prices: five times the capital buys about five times the shares.
    expect(large.quantity / small.quantity).toBeGreaterThan(4.8);
    expect(large.quantity / small.quantity).toBeLessThan(5.2);
  }, 120_000);

  it('a paused run keeps deciding and places nothing until it runs again', async () => {
    clock = afterClose('2026-10-06');
    const { runtimeId } = await startMachine('Paused');
    await pass();
    await asUser((tx) => confirmMachineStart(tx, runtimeId, new Date(clock)));
    await asUser((tx) => pauseRuntime(tx, runtimeId, 'test pause'));
    await pass();
    clock = afterClose('2026-10-07');
    await pass();
    expect((await runState(runtimeId))?.lastDecidedOn).toBe('2026-10-07');
    expect(await orders(runtimeId)).toEqual([]);
    await asUser((tx) => resumeRuntime(tx, userId, runtimeId));
    await pass();
    const m = await runState(runtimeId);
    if (m!.proposal!.legs.length > 0) expect((await orders(runtimeId)).length).toBeGreaterThan(0);
    await stopAll();
  }, 120_000);

  it('warns at Start when another run on the account trades its instruments (§2.8)', async () => {
    clock = afterClose('2026-10-06');
    await startMachine('First');
    const second = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Second', definition: machine() }),
    );
    const { validation } = await asUser((tx) => validateStoredStrategy(tx, second.id, account));
    expect(validation.warnings.map((w) => w.code)).toContain('machine_shared_account');
    // Without an account (the builder's check) there is nothing to compare with.
    const plain = await asUser((tx) => validateStoredStrategy(tx, second.id));
    expect(plain.validation.warnings.map((w) => w.code)).not.toContain('machine_shared_account');
    await stopAll();
  }, 60_000);

  it('back tests in the app with the machine engine (ADR 0124 P3b)', async () => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'Machine back test', definition: machine() }),
    );
    const inputs = { ...DEFAULT_BACKTEST_INPUTS, from: '2025-01-02', to: '2026-09-30' };
    // More than 5 years is refused, and so are member picks.
    await expect(
      asUser((tx) => startBacktest(tx, userId, s.id, { ...inputs, from: '2015-01-02' })),
    ).rejects.toThrow(/inputs need attention/);
    const run = await asUser((tx) => startBacktest(tx, userId, s.id, inputs));
    const provider = createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') });
    expect(
      await processNextRun({ db: t.app.db, provider, workerId: 'bt', logger: quiet as never }),
    ).toBe('completed');
    const done = await asUser((tx) => getBacktest(tx, run.id));
    expect(done.status).toBe('completed');
    expect(done.engineVersion).toBe('machine@1');
    const report = done.result?.machine;
    expect(report?.states.map((x) => x.id)).toEqual(['INVESTED', 'DEFENSIVE']);
    expect(report?.transitions[0]?.kind).toBe('start');
    expect(report?.stays.length).toBeGreaterThan(0);
    // The stored result is the engine's own, over the same bars.
    const def = machine();
    const ids = [demoA, demoB];
    const refs = new Map<string, InstrumentRef>(
      ids.map((id) => [
        id,
        { symbol: id === demoA ? 'DEMO-A' : 'DEMO-B', assetClass: 'stock', lotSize: '1' },
      ]),
    );
    const fitted = done.inputs;
    const data = await loadData(provider, planMachineSeries(def, fitted), refs);
    const direct = simulateMachine({ definition: def, instruments: refs, inputs: fitted, data });
    expect(report?.transitions.map((x) => [x.on, x.toStateId])).toEqual(
      direct.machine?.transitions.map((x) => [x.on, x.toStateId]),
    );
  });
});
