import {
  claimRuntimes,
  createStrategy,
  eq,
  listPositions,
  provisionWorkspace,
  schema,
  setKillSwitch,
  startStrategy,
  stopStrategy,
  updateStrategy,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDefinition, type PlannedOrder, type StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';

let t: TestDatabase;
let userId: string;
let demoA: string;
let demoB: string;
let account: string;

const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Tuesday 2026-10-06, one minute after the 10:30 New York bar closed. */
const T0 = Date.parse('2026-10-06T14:31:00Z');
let clock = T0;
const options = (workerId: string): RuntimeWorkerOptions => ({
  db: t.app.db,
  workerId,
  history: (now) => createDemoHistoryProvider({ now }),
  quotes: (now) => createDemoLiveFeed({ now }),
  now: () => new Date(clock),
  logger: quiet,
});

/** Claims and runs one pass over every runtime that needs one, at the current clock. */
async function pass(workerId = 'worker-1') {
  const claimed = await claimRuntimes(t.app.db, workerId, { leaseSeconds: 30, limit: 10 });
  for (const c of claimed) await runRuntimePass(options(workerId), c.runtimeId, c.userId);
  return claimed.length;
}

const hourly = (instrumentId: string, id: string) => ({
  kind: 'market' as const,
  id,
  instrumentId,
  field: 'close' as const,
  interval: '1h' as const,
  adjustment: 'split_and_dividend' as const,
  session: 'regular' as const,
  offset: 0,
});
const always = (id: string): StrategyDefinition['entry']['condition'] => ({
  kind: 'group',
  id: `${id}-g`,
  op: 'and',
  negate: false,
  children: [
    {
      kind: 'comparison',
      id,
      operator: 'gt',
      left: hourly(demoA, `${id}-px`),
      right: { kind: 'constant', id: `${id}-k`, value: '1' },
    },
  ],
});
const leg = (id: string, partial: Partial<PlannedOrder>): PlannedOrder => ({
  id,
  legLabel: id,
  instrumentId: demoA,
  accountId: account,
  side: 'buy',
  quantity: { type: 'units', value: '10', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  extendedHours: false,
  timing: { mode: 'immediate' },
  timingOnly: false,
  ...partial,
});

/** Long DEMO-A and short DEMO-B while the rules hold; both conditions are always true. */
function pairDefinition(): StrategyDefinition {
  const def = createDefinition();
  def.entry.condition = always('in');
  def.entry.trigger = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };
  def.exit.condition = always('out');
  def.exit.trigger = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };
  def.entry.orders = [
    leg('long', { legLabel: 'Long A' }),
    leg('short', { legLabel: 'Short B', instrumentId: demoB, side: 'sell_short' }),
  ];
  def.exit.orders = [
    leg('sell', { legLabel: 'Sell A', side: 'close' }),
    leg('cover', { legLabel: 'Cover B', instrumentId: demoB, side: 'close' }),
  ];
  return def;
}

async function startPaper(name: string, def: StrategyDefinition) {
  return asUser(async (tx) => {
    let s = await createStrategy(tx, userId, { name, definition: def });
    s = await updateStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      status: 'under_testing',
    });
    const { validation } = await validateStoredStrategy(tx, s.id);
    expect(validation.errors).toEqual([]);
    s = await startStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      confirmed: true,
      acknowledgedWarnings: validation.warnings.map((w) => w.code),
    });
    const [runtime] = await tx
      .select()
      .from(schema.strategyRuntimes)
      .where(eq(schema.strategyRuntimes.strategyId, s.id));
    return { strategy: s, runtimeId: runtime!.id };
  });
}

const orders = (runtimeId: string) =>
  asUser((tx) =>
    tx
      .select({
        id: schema.orderIntents.id,
        phase: schema.orderIntents.phase,
        legLabel: schema.orderIntents.legLabel,
        side: schema.orderIntents.side,
        direction: schema.orderIntents.direction,
        quantity: schema.orderIntents.quantity,
        triggerEventId: schema.orderIntents.triggerEventId,
        state: schema.brokerOrders.state,
        filled: schema.brokerOrders.filledQuantity,
      })
      .from(schema.orderIntents)
      .innerJoin(schema.brokerOrders, eq(schema.brokerOrders.intentId, schema.orderIntents.id))
      .where(eq(schema.orderIntents.runtimeId, runtimeId))
      .orderBy(schema.orderIntents.createdAt, schema.orderIntents.legLabel),
  );
const cycles = (runtimeId: string) =>
  asUser((tx) =>
    tx
      .select()
      .from(schema.strategyCycles)
      .where(eq(schema.strategyCycles.runtimeId, runtimeId))
      .orderBy(schema.strategyCycles.seq),
  );

/** Stops every runtime left by a test so the next one starts with an empty queue. */
async function stopAll() {
  await t.ownerSql`update strategy_runtime set status = 'stopped', stopped_at = now() where status <> 'stopped'`;
  await t.ownerSql`update broker_order set state = 'canceled', terminal_at = now() where state in ('ready', 'submitted', 'acknowledged', 'partially_filled')`;
  await t.ownerSql`update execution_control set halted_at = null`;
}

beforeAll(async () => {
  t = await createTestDatabase();
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Runner', email: 'runner@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Runner' });
  const rows = await t.owner.db.select().from(schema.instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  demoB = rows.find((r) => r.symbol === 'DEMO-B')!.id;
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('paper runtime: Entry first, Exit second (§6.9)', () => {
  it('runs a pair strategy from Entry to Exit and closes the cycle', async () => {
    clock = T0;
    const { runtimeId } = await startPaper('Pair', pairDefinition());

    // The Entry trigger fires on the bar that just closed; both legs go to the broker.
    expect(await pass()).toBe(1);
    let o = await orders(runtimeId);
    expect(o.map((x) => [x.phase, x.legLabel, x.direction, x.state])).toEqual([
      ['entry', 'Long A', 'buy', 'submitted'],
      ['entry', 'Short B', 'sell', 'submitted'],
    ]);
    expect(o.every((x) => x.triggerEventId)).toBe(true);
    expect((await cycles(runtimeId))[0]).toMatchObject({ seq: 1, status: 'entry_working' });

    // The broker fills them on its next pass; the position opens.
    clock = T0 + 5_000;
    await pass();
    o = await orders(runtimeId);
    expect(o.map((x) => x.state)).toEqual(['filled', 'filled']);
    expect((await cycles(runtimeId))[0]!.status).toBe('open');

    // Exit waits for the next completed bar, even though its condition is always true.
    clock = T0 + 60_000;
    await pass();
    expect(await orders(runtimeId)).toHaveLength(2);

    // At the next bar the Exit trigger fires and both legs close.
    clock = T0 + 3_600_000;
    await pass();
    o = await orders(runtimeId);
    expect(
      o.filter((x) => x.phase === 'exit').map((x) => [x.legLabel, x.direction, x.quantity]),
    ).toEqual([
      ['Cover B', 'buy', '10'],
      ['Sell A', 'sell', '10'],
    ]);
    clock = T0 + 3_605_000;
    await pass();
    const [cycle] = await cycles(runtimeId);
    expect(cycle!.status).toBe('closed');
    expect(cycle!.realizedPnl).not.toBeNull();
    expect(cycle!.exitTriggerEventId).not.toBeNull();

    // Positions at the paper broker are flat again.
    const held =
      await t.ownerSql`select quantity from paper_position where account_id = ${account}`;
    expect(held.every((p) => Number(p.quantity) === 0)).toBe(true);
    await stopAll();
  });

  it('records each evaluation once per new bar as a trigger event', async () => {
    clock = T0 + 86_400_000; // Wednesday
    const def = pairDefinition();
    def.entry.trigger.mode = 'on_transition';
    const { runtimeId } = await startPaper('Events', def);
    await pass();
    clock += 10_000;
    await pass();
    const events = await asUser((tx) =>
      tx.select().from(schema.triggerEvents).where(eq(schema.triggerEvents.runtimeId, runtimeId)),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ phase: 'entry', result: 'true', qualified: false });
    expect(Object.keys(events[0]!.values as object)).toEqual(['in-px']);
    await stopAll();
  });
});

describe('paper runtime: timing (§6.8)', () => {
  it('places an Exit five minutes after the Entry order, from a durable schedule', async () => {
    clock = T0 + 2 * 86_400_000; // Thursday
    const def = pairDefinition();
    def.entry.orders = [def.entry.orders[0]!];
    def.exit.orders = [
      leg('sell', {
        legLabel: 'Sell A later',
        side: 'close',
        timingOnly: true,
        timing: {
          mode: 'relative',
          amount: 5,
          unit: 'min',
          reference: { kind: 'phase', event: 'entry_submitted' },
        },
      }),
    ];
    const { runtimeId } = await startPaper('Delayed exit', def);
    const placedAt = clock;
    await pass();
    clock += 5_000;
    await pass(); // filled, open: the Exit leg is now scheduled
    const scheduled = await asUser((tx) =>
      tx
        .select()
        .from(schema.scheduledActions)
        .where(eq(schema.scheduledActions.runtimeId, runtimeId)),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ status: 'pending', phase: 'exit', legId: 'sell' });
    expect(scheduled[0]!.dueAt.getTime()).toBe(placedAt + 300_000);
    expect(scheduled[0]!.referenceId).not.toBeNull();

    clock = placedAt + 299_000;
    await pass();
    expect((await orders(runtimeId)).filter((o) => o.phase === 'exit')).toHaveLength(0);

    // A different worker picks the runtime up: nothing is lost or repeated.
    clock = placedAt + 300_000;
    await pass('worker-2');
    const exits = (await orders(runtimeId)).filter((o) => o.phase === 'exit');
    expect(exits.map((o) => o.legLabel)).toEqual(['Sell A later']);
    const [action] = await asUser((tx) =>
      tx
        .select()
        .from(schema.scheduledActions)
        .where(eq(schema.scheduledActions.runtimeId, runtimeId)),
    );
    expect(action!.status).toBe('done');
    await stopAll();
  });
});

describe('paper runtime: restarts, stop and kill switch (§8.1, §8.5)', () => {
  it('never submits twice when a pass is repeated', async () => {
    clock = T0 + 7 * 86_400_000; // the next Tuesday
    const { runtimeId } = await startPaper('Repeat', pairDefinition());
    await pass();
    // The same moment again, as if a worker restarted before its pass was noticed.
    await t.ownerSql`update strategy_runtime set lease_expires_at = null where id = ${runtimeId}`;
    await pass('worker-3');
    expect(await orders(runtimeId)).toHaveLength(2);
    const paper =
      await t.ownerSql`select count(*)::int as n from paper_order where request->>'clientOrderId' in (select idempotency_key from order_intent where runtime_id = ${runtimeId})`;
    expect(paper[0]!.n).toBe(2);
    await stopAll();
  });

  it('stops new orders without canceling working ones', async () => {
    clock = T0 + 8 * 86_400_000;
    const def = pairDefinition();
    def.entry.orders = [
      leg('long', {
        legLabel: 'Low bid',
        orderType: 'limit',
        limitPrice: { kind: 'constant', id: 'lp', value: '1' },
        timeInForce: 'gtc',
      }),
    ];
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    def.risk.priceCollarPct = '100';
    const { strategy, runtimeId } = await startPaper('Stopped', def);
    await pass();
    clock += 60_000;
    await pass();
    expect((await orders(runtimeId)).map((o) => o.state)).toEqual(['acknowledged']);

    await asUser((tx) =>
      stopStrategy(tx, userId, strategy.id, { rowVersion: strategy.rowVersion }),
    );
    // The runtime still gets passes while its order works, but places nothing new.
    clock += 3_600_000;
    expect(await pass()).toBe(1);
    const o = await orders(runtimeId);
    expect(o.map((x) => x.state)).toEqual(['acknowledged']);
    const [runtime] = await asUser((tx) =>
      tx.select().from(schema.strategyRuntimes).where(eq(schema.strategyRuntimes.id, runtimeId)),
    );
    expect(runtime!.status).toBe('stopped');
    await stopAll();
  });

  it('cancels working orders and closes positions on stop, only when asked (§8.1)', async () => {
    clock = T0 + 10 * 86_400_000;
    const def = pairDefinition();
    def.entry.orders = [
      leg('long', { legLabel: 'Long A' }),
      leg('bid', {
        legLabel: 'Low bid',
        instrumentId: demoB,
        orderType: 'limit',
        limitPrice: { kind: 'constant', id: 'lp', value: '1' },
        timeInForce: 'gtc',
      }),
    ];
    def.exit.orders = [
      leg('sell', { legLabel: 'Sell A', side: 'close' }),
      leg('sell-b', { legLabel: 'Sell B', instrumentId: demoB, side: 'close' }),
    ];
    // Exit never triggers, so only the stop choices act on what is open.
    def.exit.condition = {
      kind: 'group',
      id: 'out-g',
      op: 'and',
      negate: false,
      children: [
        {
          kind: 'comparison',
          id: 'out',
          operator: 'lt',
          left: hourly(demoA, 'out-px'),
          right: { kind: 'constant', id: 'out-k', value: '1' },
        },
      ],
    };
    def.risk.priceCollarPct = '100';
    const { strategy, runtimeId } = await startPaper('Wind down', def);
    await pass();
    clock += 10_000;
    await pass();
    expect((await orders(runtimeId)).map((o) => [o.legLabel, o.state])).toEqual([
      ['Long A', 'filled'],
      ['Low bid', 'acknowledged'],
    ]);

    await asUser((tx) =>
      stopStrategy(tx, userId, strategy.id, {
        rowVersion: strategy.rowVersion,
        cancelOpenOrders: true,
        closePositions: true,
      }),
    );
    clock += 10_000;
    await pass();
    clock += 10_000;
    await pass();
    const after = await orders(runtimeId);
    expect(after.map((o) => [o.phase, o.legLabel, o.side, o.state])).toEqual([
      ['entry', 'Long A', 'buy', 'filled'],
      ['entry', 'Low bid', 'buy', 'canceled'],
      ['flatten', 'Close DEMO-A', 'sell', 'filled'],
    ]);
    expect(await asUser((tx) => listPositions(tx, { runtimeId }))).toEqual([]);
    // Nothing left working, so the stopped runtime is no longer claimed.
    expect(await pass()).toBe(0);
    await stopAll();
  });

  it('places nothing while the kill switch is engaged', async () => {
    clock = T0 + 9 * 86_400_000;
    const { runtimeId } = await startPaper('Halted', pairDefinition());
    const { paused } = await asUser((tx) => setKillSwitch(tx, userId, true, 'test'));
    expect(paused).toBe(1);
    await pass();
    expect(await orders(runtimeId)).toEqual([]);
    expect(await cycles(runtimeId)).toEqual([]);
    const audit = await asUser((tx) =>
      tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'execution.kill_switch_engaged')),
    );
    expect(audit).toHaveLength(1);
    await stopAll();
  });
});
