import {
  addSeedUnderlyings,
  and,
  claimRuntimes,
  createFeed,
  saveOptionSignal,
  createStrategy,
  eq,
  isNull,
  listCycleTrades,
  listNotifications,
  listPositions,
  resumeRuntime,
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
import {
  BrokerUnavailableError,
  createDefinition,
  OPTION_SIGNAL_FIELDS,
  type OptionSignalValues,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runRuntimePass, SAFETY, type RuntimeWorkerOptions } from '../src/runtime';

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
/** Test hooks: stale prices and a broker that stops answering. */
let quoteDelayMs = 0;
let brokerDown = false;
const options = (workerId: string): RuntimeWorkerOptions => ({
  db: t.app.db,
  workerId,
  history: (now) => createDemoHistoryProvider({ now }),
  quotes: (now) => {
    const feed = createDemoLiveFeed({ now });
    return {
      ...feed,
      latestQuote: async (ref) => {
        const q = await feed.latestQuote(ref);
        return q && quoteDelayMs > 0
          ? { ...q, at: new Date(Date.parse(q.at) - quoteDelayMs).toISOString() }
          : q;
      },
    };
  },
  now: () => new Date(clock),
  logger: quiet,
  wrapBroker: (broker) => ({
    ...broker,
    id: broker.id,
    capabilities: broker.capabilities,
    submitOrder: (r) => broker.submitOrder(r),
    cancelOrder: (a, o) => broker.cancelOrder(a, o),
    orderUpdates: (a, o) => broker.orderUpdates(a, o),
    positions: (a) => broker.positions(a),
    updates: (a, c) => {
      if (brokerDown) throw new BrokerUnavailableError('test: broker down');
      return broker.updates(a, c);
    },
  }),
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
  timing: { mode: 'immediate' },
  ...partial,
});

/** A condition that is never true: DEMO-A below 1. */
const never = (): StrategyDefinition['exit']['condition'] => ({
  kind: 'group',
  id: 'never-g',
  op: 'and',
  negate: false,
  children: [
    {
      kind: 'comparison',
      id: 'never',
      operator: 'lt',
      left: hourly(demoA, 'never-px'),
      right: { kind: 'constant', id: 'never-k', value: '1' },
    },
  ],
});

/** Long DEMO-A and short DEMO-B while the rules hold; both conditions are always true. */
function pairDefinition(): StrategyDefinition {
  const def = createDefinition();
  def.entry.condition = always('in');
  def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
  def.exit.condition = always('out');
  def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
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
  await t.ownerSql`update execution_incident set resolved_at = now(), resolved_by = 'system' where resolved_at is null`;
  quoteDelayMs = 0;
  brokerDown = false;
}

const incidents = () =>
  asUser((tx) =>
    tx.select().from(schema.executionIncidents).where(isNull(schema.executionIncidents.resolvedAt)),
  );
const runtimeStatus = async (runtimeId: string) =>
  (
    await asUser((tx) =>
      tx
        .select({
          status: schema.strategyRuntimes.status,
          reason: schema.strategyRuntimes.pauseReason,
        })
        .from(schema.strategyRuntimes)
        .where(eq(schema.strategyRuntimes.id, runtimeId)),
    )
  )[0];
const notificationKinds = async () =>
  (await asUser((tx) => listNotifications(tx, { limit: 200 }))).notifications.map((n) => n.kind);

beforeAll(async () => {
  t = await createTestDatabase();
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Runner', email: 'runner@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Runner' });
  // Each test leaves a strategy running; more than the dev plan runs at once.
  await t.owner.db.update(schema.entitlements).set({ overrides: { activeStrategies: 100 } });
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
    const { runtimeId, strategy } = await startPaper('Pair', pairDefinition());
    const strategyId = strategy.id;

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

    // The ledger (§10) gives one trade for the cycle, with each leg's part, and agrees
    // with the runtime's own cash count and with a hand calculation from the fills.
    const filled = await t.ownerSql<
      { leg: string; direction: string; qty: string; price: string }[]
    >`
      select i.leg_label as leg, i.direction, f.quantity as qty, f.price
        from fill f join order_intent i on i.id = f.intent_id where i.runtime_id = ${runtimeId}`;
    const px = (leg: string) => Number(filled.find((f) => f.leg === leg)!.price);
    const longA = (px('Sell A') - px('Long A')) * 10;
    const shortB = (px('Short B') - px('Cover B')) * 10;
    const [trade, ...others] = await asUser((tx) =>
      listCycleTrades(tx, { strategyIds: [strategyId] }),
    );
    expect(others).toEqual([]);
    expect(trade).toMatchObject({ seq: 1, strategyName: 'Pair', versionNo: 1, mode: 'paper' });
    expect(trade!.closedAt).not.toBeNull();
    expect(trade!.legs.map((l) => [l.legLabel, l.symbol, l.side, l.opened, l.closed])).toEqual([
      ['Long A', 'DEMO-A', 'long', '10', '10'],
      ['Short B', 'DEMO-B', 'short', '10', '10'],
    ]);
    expect(Number(trade!.legs[0]!.net)).toBeCloseTo(longA, 2);
    expect(Number(trade!.legs[1]!.net)).toBeCloseTo(shortB, 2);
    expect(trade!.net).toBe(Number(cycle!.realizedPnl).toFixed(2));
    expect(Number(trade!.net)).toBeCloseTo(longA + shortB, 2);

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

describe('paper runtime: position values in Exit rules', () => {
  it('measures the gain from the Entry fill and exits on it', async () => {
    clock = T0 + 2 * 86_400_000; // Thursday
    const def = createDefinition();
    def.entry.condition = always('pin');
    def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    def.entry.orders = [leg('buy', { legLabel: 'Buy A' })];
    const pos = (id: string, field: 'entry_price' | 'gain_pct') => ({
      kind: 'position' as const,
      id,
      instrumentId: demoA,
      field,
      interval: '1h' as const,
      adjustment: 'split_and_dividend' as const,
      session: 'regular' as const,
    });
    // A take-profit whose target is always met, so the test does not depend on prices.
    def.exit.condition = {
      kind: 'group',
      id: 'tp-g',
      op: 'and',
      negate: false,
      children: [
        {
          kind: 'comparison',
          id: 'tp',
          operator: 'gte',
          left: pos('tp-gain', 'gain_pct'),
          right: { kind: 'constant', id: 'tp-k', value: '-100' },
        },
        {
          kind: 'comparison',
          id: 'tp-held',
          operator: 'gt',
          left: pos('tp-entry', 'entry_price'),
          right: { kind: 'constant', id: 'tp-zero', value: '0' },
        },
      ],
    };
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    const { runtimeId } = await startPaper('Take profit', def);

    await pass();
    clock += 5_000;
    await pass();
    expect((await cycles(runtimeId))[0]!.status).toBe('open');

    // At the next bar the Exit rules read the cycle's fill and fire.
    clock += 3_600_000;
    await pass();
    const o = await orders(runtimeId);
    expect(o.map((x) => [x.phase, x.direction, x.quantity])).toEqual([
      ['entry', 'buy', '10'],
      ['exit', 'sell', '10'],
    ]);
    const [fill] = await t.ownerSql<{ price: string }[]>`
      select f.price from fill f join order_intent i on i.id = f.intent_id
       where i.runtime_id = ${runtimeId} and i.phase = 'entry'`;
    const [exitEvent] = await asUser((tx) =>
      tx
        .select()
        .from(schema.triggerEvents)
        .where(
          and(
            eq(schema.triggerEvents.runtimeId, runtimeId),
            eq(schema.triggerEvents.phase, 'exit'),
          ),
        ),
    );
    expect(exitEvent).toMatchObject({ result: 'true', qualified: true });
    const values = exitEvent!.values as Record<string, string | null>;
    expect(Number(values['tp-entry'])).toBeCloseTo(Number(fill!.price), 6);
    expect(values['tp-gain']).not.toBeNull();
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
        timing: {
          mode: 'relative',
          amount: 5,
          unit: 'min',
          reference: { kind: 'phase', event: 'entry_submitted' },
        },
      }),
    ];
    def.execution.timingOnly = true;
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

describe('paper runtime: price collar on orders decided while closed (§7.2, §8.6)', () => {
  it('holds an opening market order for the open and sends it only within the collar', async () => {
    // Tuesday 2026-10-20, 8:00 New York: decided before the open.
    clock = Date.parse('2026-10-20T12:00:00Z');
    const withCollar = (pct: string) => {
      const def = pairDefinition();
      def.entry.orders = [def.entry.orders[0]!];
      def.exit.condition = never();
      def.exit.orders = [def.exit.orders[0]!];
      def.risk.priceCollarPct = pct;
      return def;
    };
    const wide = await startPaper('Wide collar', withCollar('50'));
    const tight = await startPaper('Tight collar', withCollar('0.0001'));
    await pass();

    // Recorded, risk-checked and held: nothing has reached the broker yet.
    for (const { runtimeId } of [wide, tight]) {
      const held = await orders(runtimeId);
      expect(held.map((o) => o.state)).toEqual(['ready']);
    }
    const sent = async (runtimeId: string) =>
      (
        await t.ownerSql`select count(*)::int as n from paper_order where request->>'clientOrderId' in (select idempotency_key from order_intent where runtime_id = ${runtimeId})`
      )[0]!.n;
    expect(await sent(wide.runtimeId)).toBe(0);

    // At the open: within 50% it goes out; past 0.0001% it is canceled with the reason.
    clock = Date.parse('2026-10-20T13:31:00Z');
    await pass();
    expect(await sent(wide.runtimeId)).toBe(1);
    expect(await sent(tight.runtimeId)).toBe(0);
    const [canceled] = await orders(tight.runtimeId);
    expect(canceled!.state).toBe('canceled');
    const [order] = await asUser((tx) =>
      tx
        .select({ reason: schema.brokerOrders.reason })
        .from(schema.brokerOrders)
        .where(eq(schema.brokerOrders.intentId, canceled!.id)),
    );
    expect(order!.reason).toMatch(
      /The price opened at \$[\d.]+, [\d.]+% from \$[\d.]+ when the order was decided\. The price collar allows 0\.0001%\./,
    );
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

describe('safety: reconciliation and automatic pauses (§8.5, §8.6, §16.3)', () => {
  it('notifies start, trigger and fill, and reconciles quietly while all agrees', async () => {
    clock = T0 + 13 * 86_400_000;
    const def = pairDefinition();
    def.exit.condition = never();
    const { runtimeId } = await startPaper('Quiet', def);
    await pass();
    clock += 10_000;
    await pass();
    clock += SAFETY.reconcileEveryMs;
    await pass();
    expect((await orders(runtimeId)).every((o) => o.state === 'filled')).toBe(true);
    expect(await incidents()).toEqual([]);
    const kinds = await notificationKinds();
    for (const k of ['strategy_started', 'triggered', 'filled'] as const)
      expect(kinds).toContain(k);
    expect((await runtimeStatus(runtimeId))?.status).toBe('running');
    await stopAll();
  });

  it('opens an incident and pauses the strategy when positions disagree with the broker', async () => {
    clock = T0 + 14 * 86_400_000;
    const def = pairDefinition();
    def.exit.condition = never();
    const { runtimeId } = await startPaper('Mismatch', def);
    await pass();
    clock += 10_000;
    await pass();
    // Something changes the broker's books behind the app's back.
    await t.ownerSql`update paper_position set quantity = quantity + 5 where instrument_id = ${demoA}`;
    clock += SAFETY.reconcileEveryMs;
    await pass();

    const [incident] = await incidents();
    expect(incident).toMatchObject({
      kind: 'reconciliation_mismatch',
      accountId: account,
      pausedRuntimes: 1,
    });
    expect(incident!.summary).toContain('DEMO-A');
    expect(await runtimeStatus(runtimeId)).toMatchObject({ status: 'paused' });
    const kinds = await notificationKinds();
    expect(kinds).toContain('reconciliation_mismatch');
    expect(kinds).toContain('risk_pause');
    await t.ownerSql`update paper_position set quantity = quantity - 5 where instrument_id = ${demoA}`;
    await stopAll();
  });

  it('pauses after repeated rejected orders, counting only since the last resume', async () => {
    clock = T0 + 15 * 86_400_000;
    const def = pairDefinition();
    def.risk.maxOrderNotional = '1';
    const { runtimeId } = await startPaper('Rejected', def);
    for (let i = 0; i < 3; i++) {
      await pass();
      clock += 3_600_000;
    }
    const states = (await orders(runtimeId)).map((o) => o.state);
    expect(states.filter((x) => x === 'rejected').length).toBeGreaterThanOrEqual(
      SAFETY.rejectsInARow,
    );
    expect(await runtimeStatus(runtimeId)).toMatchObject({ status: 'paused' });
    expect((await incidents()).map((i) => i.kind)).toEqual(['repeated_rejects']);
    expect(await notificationKinds()).toContain('order_rejected');

    // Resuming starts a fresh count: the old rejections do not pause it again at once.
    await t.ownerSql`update execution_incident set resolved_at = now(), resolved_by = 'user' where resolved_at is null`;
    await asUser((tx) => resumeRuntime(tx, userId, runtimeId));
    clock += 60_000;
    await pass();
    expect((await runtimeStatus(runtimeId))?.status).toBe('running');
    await stopAll();
  });

  it('flags stale prices at once and pauses if they stay stale; clears when current', async () => {
    clock = T0 + 16 * 86_400_000;
    const def = pairDefinition();
    def.exit.condition = never();
    const { runtimeId } = await startPaper('Stale', def);
    quoteDelayMs = 10 * 60_000;
    await pass();
    expect((await incidents()).map((i) => i.kind)).toEqual(['stale_data']);
    expect((await runtimeStatus(runtimeId))?.status).toBe('running');
    // Stale prices fail the risk check, so nothing was ordered.
    expect((await orders(runtimeId)).every((o) => o.state === 'rejected')).toBe(true);

    clock += SAFETY.feedLossPauseMs;
    await pass();
    expect((await incidents()).map((i) => i.kind).sort()).toEqual(['feed_loss', 'stale_data']);
    expect((await runtimeStatus(runtimeId))?.status).toBe('paused');
    expect(await notificationKinds()).toEqual(expect.arrayContaining(['stale_data', 'disconnect']));

    quoteDelayMs = 0;
    await asUser((tx) => resumeRuntime(tx, userId, runtimeId));
    clock += 10_000;
    await pass();
    // The data incident clears itself; the pause incident waits for a person.
    expect((await incidents()).map((i) => i.kind)).toEqual(['feed_loss']);
    await stopAll();
  });

  it('pauses when the broker stops answering, and clears when it answers again', async () => {
    clock = T0 + 17 * 86_400_000;
    const def = pairDefinition();
    def.exit.condition = never();
    const { runtimeId } = await startPaper('Unreachable', def);
    await pass();
    brokerDown = true;
    clock += 10_000;
    await pass();
    expect(await incidents()).toEqual([]);
    clock += SAFETY.brokerDownPauseMs;
    await pass();
    expect((await incidents()).map((i) => i.kind)).toEqual(['broker_disconnected']);
    expect((await runtimeStatus(runtimeId))?.status).toBe('paused');
    expect(await notificationKinds()).toContain('disconnect');

    brokerDown = false;
    clock += 10_000;
    await pass();
    expect(await incidents()).toEqual([]);
    await stopAll();
  });
});

describe('paper runtime: v1.2 Selection groups, per-leg conditions, schedule, time stop', () => {
  const CONTEXT = '00000000-0000-0000-0000-000000000000';
  const daily = (instrumentId: string, id: string) => ({
    ...hourly(instrumentId, id),
    interval: '1d' as const,
  });
  const group = (id: string, children: StrategyDefinition['entry']['condition']['children']) => ({
    kind: 'group' as const,
    id,
    op: 'and' as const,
    negate: false,
    children,
  });
  const above = (id: string, instrumentId: string, value: string) => ({
    kind: 'comparison' as const,
    id,
    operator: 'gt' as const,
    left: hourly(instrumentId, `${id}-px`),
    right: { kind: 'constant' as const, id: `${id}-k`, value },
  });

  it('fires only the leg whose own condition holds, in its own cycle', async () => {
    clock = T0 + 2 * 86_400_000; // Thursday
    const def = createDefinition();
    def.entry.orders = [
      leg('a', { legLabel: 'Buy A', legCondition: group('ca', [above('ca1', demoA, '1')]) }),
      leg('b', {
        legLabel: 'Buy B',
        instrumentId: demoB,
        legCondition: group('cb', [above('cb1', demoB, '1000000')]),
      }),
    ];
    def.exit.condition = never();
    def.exit.orders = [
      leg('sa', { legLabel: 'Sell A', side: 'close' }),
      leg('sb', { legLabel: 'Sell B', instrumentId: demoB, side: 'close' }),
    ];
    const { runtimeId } = await startPaper('Per-leg', def);
    await pass();
    const o = await orders(runtimeId);
    expect(o.map((x) => [x.phase, x.legLabel])).toEqual([['entry', 'Buy A']]);
    const [c] = await cycles(runtimeId);
    expect((c!.state as { slot?: { instrumentId: string } }).slot?.instrumentId).toBe(demoA);
    // Entry-only on a daily schedule: nothing else fires while A is held.
    clock += 3_600_000;
    await pass();
    expect((await orders(runtimeId)).filter((x) => x.phase === 'entry')).toHaveLength(1);
    await stopAll();
  });

  it('holds the top-ranked member of a list universe, with split sizing', async () => {
    clock = T0 + 3 * 86_400_000; // Friday
    const def = createDefinition();
    def.trade = {
      kind: 'group',
      universe: { type: 'list', instrumentIds: [demoA, demoB] },
      ranking: {
        metric: 'return',
        params: { lookbackMonths: '1', skipMonths: '0' },
        direction: 'desc',
        count: { type: 'fixed', value: 2 },
      },
      splitTotal: true,
    };
    def.exit.rules = [{ kind: 'leftGroup', id: 'left' }];
    def.entry.orders = [
      leg('each', {
        legLabel: 'Buy each',
        instrumentId: CONTEXT,
        quantity: { type: 'units', value: '20', rounding: 'down' },
      }),
    ];
    def.exit.orders = [
      leg('close-each', { legLabel: 'Close each', instrumentId: CONTEXT, side: 'close' }),
    ];
    const { runtimeId } = await startPaper('Selection', def);
    await pass();
    const o = await orders(runtimeId);
    // Both members are selected; 20 shares split equally across the 2 selections.
    expect(o.map((x) => [x.legLabel, x.quantity])).toEqual([
      ['Buy each', '10'],
      ['Buy each', '10'],
    ]);
    const slots = (await cycles(runtimeId)).map(
      (c) => (c.state as { slot?: { instrumentId: string } }).slot?.instrumentId,
    );
    expect(new Set(slots)).toEqual(new Set([demoA, demoB]));
    // Re-evaluated on the next bar: still selected, so nothing is sold and bought back.
    clock += 86_400_000 * 3; // Monday
    await pass();
    expect(await orders(runtimeId)).toHaveLength(2);
    await stopAll();
  });

  it('refuses to start an S&P 500 Selection group on paper, saying why', async () => {
    const def = createDefinition();
    def.trade = {
      kind: 'group',
      universe: { type: 'builtin', id: 'sp500' },
      ranking: {
        metric: 'return',
        params: {},
        direction: 'desc',
        count: { type: 'fixed', value: 10 },
      },
    };
    def.entry.orders = [leg('each', { instrumentId: CONTEXT })];
    def.exit.orders = [leg('close-each', { instrumentId: CONTEXT, side: 'close' })];
    await expect(startPaper('S&P', def)).rejects.toThrow(
      /can be back tested, but not run on paper/,
    );
  });

  it('evaluates Entry only after a month-end close', async () => {
    // Thursday 2026-10-29, mid-session: October's last trading day is Friday the 30th.
    clock = Date.parse('2026-10-29T15:31:00Z');
    const def = pairDefinition();
    def.entry.condition = group('in-g', [
      { ...above('in', demoA, '1'), left: daily(demoA, 'in-px') },
    ]);
    def.exit.condition = never();
    def.entry.schedule = { which: 'every', bar: '1d', days: 'monthEnd' };
    const { runtimeId } = await startPaper('Month end', def);
    await pass();
    clock = Date.parse('2026-10-30T15:31:00Z'); // the 29th's daily bar is in, but not a month end
    await pass();
    expect(await orders(runtimeId)).toHaveLength(0);
    clock = Date.parse('2026-10-30T20:05:00Z'); // after the close of October's last trading day
    await pass();
    expect((await orders(runtimeId)).map((x) => x.phase)).toEqual(['entry', 'entry']);
    await stopAll();
  });

  it('exits after N trading days held, by the time stop alone', async () => {
    clock = Date.parse('2026-11-02T15:31:00Z'); // Monday
    const def = pairDefinition();
    def.exit.condition = never();
    def.exit.rules = [{ kind: 'timeStop', id: 'ts', barsHeld: 2 }];
    const { runtimeId } = await startPaper('Time stop', def);
    await pass();
    clock += 5_000;
    await pass(); // filled on Monday
    expect((await cycles(runtimeId))[0]!.status).toBe('open');
    clock = Date.parse('2026-11-02T21:00:00Z'); // Monday's close: held 1 day
    await pass();
    expect((await orders(runtimeId)).filter((x) => x.phase === 'exit')).toHaveLength(0);
    clock = Date.parse('2026-11-03T21:00:00Z'); // Tuesday's close: held 2 days
    await pass();
    expect((await orders(runtimeId)).filter((x) => x.phase === 'exit')).toHaveLength(2);
    const [c] = await cycles(runtimeId);
    expect((c!.state as { exitReason?: string }).exitReason).toBe('time_stop');
    await stopAll();
  });
});

describe('paper runtime: long and short entry groups (v1.2 item 8)', () => {
  const twoSided = (longEntry: StrategyDefinition['entry']['condition']) => {
    const def = createDefinition();
    def.entry.condition = longEntry;
    def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    def.entry.orders = [leg('buy', { legLabel: 'Buy A' })];
    def.exit.condition = never();
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    def.groups = [
      {
        id: 'short-1',
        label: 'Short A group',
        entry: {
          condition: always('sin'),
          trigger: { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 },
          orders: [leg('short', { legLabel: 'Short A', side: 'sell_short' })],
        },
        exit: {
          condition: always('sout'),
          trigger: { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 },
          orders: [leg('cover', { legLabel: 'Cover A', side: 'close' })],
        },
      },
    ];
    return def;
  };

  it('opens the short group when only it qualifies, and exits by its own Exit', async () => {
    clock = Date.parse('2026-11-04T15:31:00Z');
    const notYet = structuredClone(never());
    notYet.id = 'not-yet-g';
    notYet.children = notYet.children.map((c) => ({ ...c, id: `not-yet-${c.id}` }));
    const { runtimeId } = await startPaper('Two-sided short', twoSided(notYet));
    await pass();
    expect((await orders(runtimeId)).map((x) => [x.legLabel, x.side])).toEqual([
      ['Short A', 'sell_short'],
    ]);
    const [c] = await cycles(runtimeId);
    expect((c!.state as { group?: string }).group).toBe('short-1');
    clock += 5_000;
    await pass(); // filled
    clock += 3_600_000;
    await pass(); // the group's Exit holds
    expect((await orders(runtimeId)).map((x) => x.legLabel)).toEqual(['Short A', 'Cover A']);
    await stopAll();
  });

  it('never flips: the short group waits while the long position is open', async () => {
    clock = Date.parse('2026-11-05T15:31:00Z');
    const { runtimeId } = await startPaper('Two-sided long', twoSided(always('lin')));
    await pass();
    clock += 5_000;
    await pass();
    clock += 3_600_000;
    await pass();
    expect((await orders(runtimeId)).map((x) => x.legLabel)).toEqual(['Buy A']);
    expect(await cycles(runtimeId)).toHaveLength(1);
    await stopAll();
  });
});

describe('paper runtime: risk sizing from ATR and the ATR stop (v1.2 item 9)', () => {
  /** Risk a % of equity over the Entry's ATR distance (ADR 0049). */
  const riskAtr = (value = '1') => ({
    type: 'risk' as const,
    value,
    rounding: 'down' as const,
    amountIn: 'pct_equity' as const,
    distanceFrom: 'atr' as const,
  });

  it('sizes the Entry from equity, risk % and ATR, and records how', async () => {
    clock = Date.parse('2026-11-04T15:31:00Z');
    const def = pairDefinition();
    def.entry.orders = [leg('buy', { legLabel: 'Buy A', quantity: riskAtr() })];
    def.entry.risk = { atrPeriod: 5, atrMultiple: '2' };
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    def.exit.condition = never();
    def.exit.rules = [{ kind: 'atrStop', id: 'atr' }];
    def.risk = { ...def.risk, maxOrderNotional: '1000000', maxStrategyExposure: '1000000' };
    const { runtimeId } = await startPaper('Risk ATR', def);
    await pass();
    const [o] = await orders(runtimeId);
    const [c] = await cycles(runtimeId);
    const state = c!.state as {
      atrAtEntry?: string;
      sizing?: Record<
        string,
        {
          quantity: string;
          stopDistance: string;
          equity: string;
          riskPct: string;
          atr: string;
          cappedBy?: string;
        }
      >;
    };
    const s = state.sizing?.buy;
    expect(s).toBeDefined();
    expect(state.atrAtEntry).toBeDefined();
    // quantity = floor(equity × 1% ÷ (ATR × 2)), unless a limit capped it.
    const byRisk = Math.floor((Number(s!.equity) * 0.01) / (Number(s!.atr) * 2));
    expect(Number(s!.stopDistance)).toBeCloseTo(Number(s!.atr) * 2, 8);
    expect(o!.quantity).toBe(s!.quantity);
    if (!s!.cappedBy) expect(Number(o!.quantity)).toBe(byRisk);
    else expect(Number(o!.quantity)).toBeLessThan(byRisk);
    await stopAll();
  });

  it('places nothing when the risk budget buys less than one share, and says why', async () => {
    clock = Date.parse('2026-11-05T15:31:00Z');
    const def = pairDefinition();
    def.entry.orders = [leg('buy', { legLabel: 'Buy A', quantity: riskAtr('0.001') })];
    def.entry.risk = { atrPeriod: 5, atrMultiple: '2' };
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    def.exit.condition = never();
    const { runtimeId } = await startPaper('Risk ATR, too small', def);
    await pass();
    expect(await orders(runtimeId)).toHaveLength(0);
    const [c] = await cycles(runtimeId);
    expect(
      (c!.state as { sizing?: Record<string, { skipped?: string }> }).sizing?.buy?.skipped,
    ).toBe('zero_quantity');
    await stopAll();
  });
});

describe('paper runtime: the expected-move exit (ADR 0053)', () => {
  it('captures the first Entry leg’s expected move when Entry is decided', async () => {
    clock = Date.parse('2026-11-04T15:31:00Z');
    await addSeedUnderlyings(t.worker.db, [demoA]);
    const nulls = Object.fromEntries(
      OPTION_SIGNAL_FIELDS.map((f) => [f, null]),
    ) as OptionSignalValues;
    await saveOptionSignal(t.worker.db, {
      underlyingId: demoA,
      asOfDate: '2026-11-03',
      values: { ...nulls, expected_move_5d_pct: 0.031 },
      ivHistoryDays: 0,
      expiries: [],
      underlyingClose: 100,
      riskFreeRate: 0.04,
      dividendYield: 0,
      source: 'recorded',
      feed: 'cboe',
      computedAt: new Date(),
    });
    await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'CBOE delayed options (daily)',
        provider: 'cboe_options',
        assetClasses: ['stock', 'etf'],
      }),
    );
    const def = pairDefinition();
    def.entry.orders = [leg('buy', { legLabel: 'Buy A' })];
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    def.exit.condition = never();
    def.exit.rules = [
      { kind: 'expectedMove', id: 'em', horizon: 5, multiple: '1', side: 'either' },
    ];
    const { runtimeId } = await startPaper('Expected-move exit', def);
    await pass();
    expect(await orders(runtimeId)).toHaveLength(1);
    const [c] = await cycles(runtimeId);
    expect((c!.state as { moveAtEntry?: string }).moveAtEntry).toBe('0.031');
    await stopAll();
  });
});

describe('paper runtime: the trailing stop (ADR 0059)', () => {
  it('keeps the best close since entry with the cycle once Entry has filled', async () => {
    clock = Date.parse('2026-11-04T15:31:00Z');
    const def = pairDefinition();
    def.entry.orders = [leg('buy', { legLabel: 'Buy A' })];
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
    def.exit.condition = never();
    def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent: '1' }];
    const { runtimeId } = await startPaper('Trailing stop', def);
    await pass();
    clock += 10_000;
    await pass();
    // A later bar: the stop is checked on new data once the position is open.
    clock += 3_600_000;
    await pass();
    expect((await orders(runtimeId)).map((o) => [o.legLabel, o.state])[0]).toEqual([
      'Buy A',
      'filled',
    ]);
    const [c] = await cycles(runtimeId);
    expect(Number((c!.state as { trailPeak?: string }).trailPeak)).toBeGreaterThan(0);
    await stopAll();
  });
});
