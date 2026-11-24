import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  claimRuntimes,
  createDb,
  createStrategy,
  eq,
  getBacktest,
  listBacktestTrades,
  listOrders,
  provisionWorkspace,
  RESEARCH_TABLES,
  researchStore,
  researchTx,
  schema,
  sql,
  startBacktest,
  startStrategy,
  updateStrategy,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';
import { createRuntimeCaches, runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';

/**
 * The separation proof (ADR 0115, storage brief S1):
 *
 * A1. With the Research database stopped, running strategies still evaluate,
 *     orders still flow, and the Orders page's data still loads.
 * A2. With Core stopped, back tests fail loudly and nothing trades silently.
 *
 * The Research database here is a real, separate database that the test
 * drops part-way through (connections cut), not a mock.
 */

let t: TestDatabase;
let userId: string;
let demoA: string;
let account: string;

const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Tuesday 2026-10-06, one minute after the 10:30 New York bar closed. */
const T0 = Date.parse('2026-10-06T14:31:00Z');
let clock = T0;
const DEAD_URL = 'postgres://nobody:x@127.0.0.1:1/stopped';

const runtimeOptions = (db = t.app.db): RuntimeWorkerOptions => ({
  db,
  caches: createRuntimeCaches(async () => ({ ids: [], warnings: [] })),
  workerId: 'w-a1',
  history: (now) => createDemoHistoryProvider({ now }),
  quotes: (now) => createDemoLiveFeed({ now }),
  now: () => new Date(clock),
  logger: quiet,
});

async function pass(db = t.app.db) {
  const claimed = await claimRuntimes(db, 'w-a1', { leaseSeconds: 30, limit: 10 });
  for (const c of claimed) await runRuntimePass(runtimeOptions(db), c.runtimeId, c.userId);
  return claimed.length;
}

const px = () => ({
  kind: 'market' as const,
  instrumentId: demoA,
  field: 'close' as const,
  interval: '1h' as const,
  adjustment: 'split_and_dividend' as const,
  session: 'regular' as const,
  offset: 0,
});

/** Buys DEMO-A while its close is above 1 (always): an Entry that fires on the first pass. */
function alwaysBuy(): StrategyDefinition {
  const def = createDefinition();
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'in',
      operator: 'gt',
      left: { ...px(), id: 'p1' },
      right: { kind: 'constant', id: 'k1', value: '1' },
    },
  ];
  def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'out',
      operator: 'lt',
      left: { ...px(), id: 'p2' },
      right: { kind: 'constant', id: 'k2', value: '1' },
    },
  ];
  const leg = {
    instrumentId: demoA,
    accountId: account,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell A', side: 'close', ...leg }];
  return def;
}

async function startPaper(name: string) {
  return asUser(async (tx) => {
    let s = await createStrategy(tx, userId, { name, definition: alwaysBuy() });
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
    return { strategyId: s.id, runtimeId: runtime!.id };
  });
}

const orderStates = (runtimeId: string) =>
  asUser((tx) =>
    tx
      .select({ state: schema.brokerOrders.state })
      .from(schema.orderIntents)
      .innerJoin(schema.brokerOrders, eq(schema.brokerOrders.intentId, schema.orderIntents.id))
      .where(eq(schema.orderIntents.runtimeId, runtimeId)),
  );

beforeAll(async () => {
  t = await createTestDatabase({ research: true });
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Sep', email: 'separation@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Sep' });
  await t.owner.db.update(schema.entitlements).set({ overrides: { activeStrategies: 100 } });
  demoA = (await t.owner.db.select().from(schema.instruments)).find(
    (r) => r.symbol === 'DEMO-A',
  )!.id;
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
}, 90_000);

afterAll(async () => {
  await t?.drop();
});

describe('trading code never touches the Research Store', () => {
  // The paper runtime, the order flow and the Orders page's reads.
  const files = [
    '../src/runtime.ts',
    '../src/runtime-cache.ts',
    '../src/account-router.ts',
    '../src/account-sync.ts',
    '../src/brokers.ts',
    '../src/quote-hub.ts',
    '../../../packages/db/src/runtime.ts',
    '../../../packages/db/src/orders.ts',
    '../../../packages/db/src/order-views.ts',
    '../../../packages/db/src/paper-broker-store.ts',
    '../../../packages/db/src/reconcile.ts',
  ];
  it.each(files)('%s names no research table and no research connection', (file) => {
    const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    for (const table of RESEARCH_TABLES) expect(text).not.toMatch(new RegExp(`\\b${table}\\b`));
    expect(text).not.toMatch(/research(Store|Tx|DATABASE)|RESEARCH_DATABASE/i);
  });
});

describe('A1: with the Research database stopped', () => {
  it('back tests still store trades in Research while it is up (the setup works)', async () => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'BT', definition: alwaysBuy() }),
    );
    const run = await asUser((tx) =>
      startBacktest(tx, userId, s.id, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    );
    const research = researchStore(t.app.db, t.research!.app.db);
    const outcome = await processNextRun({
      db: t.app.db,
      research,
      provider: createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') }),
      workerId: 'w-bt',
      logger: quiet,
    });
    expect(outcome).toBe('completed');
    const inResearch = await t.research!
      .ownerSql`select count(*)::int as n from backtest_trade where run_id = ${run.id}`;
    expect(inResearch[0]?.n).toBeGreaterThan(0);
    const inCore =
      await t.ownerSql`select count(*)::int as n from backtest_trade where run_id = ${run.id}`;
    expect(inCore[0]?.n).toBe(0);
    const trades = await asUser((tx) =>
      listBacktestTrades(tx, run.id, researchTx(research, { userId })),
    );
    expect(trades.length).toBe(inResearch[0]?.n);
  }, 60_000);

  it('running strategies evaluate, orders flow, and the Orders page loads', async () => {
    await t.research!.stop();
    clock = T0;
    const { runtimeId } = await startPaper('A1 paper');
    // The Entry fires on the bar that just closed and its order reaches the broker.
    expect(await pass()).toBe(1);
    expect((await orderStates(runtimeId)).map((o) => o.state)).toEqual(['submitted']);
    // The broker fills it on its next pass.
    clock = T0 + 5_000;
    await pass();
    expect((await orderStates(runtimeId)).map((o) => o.state)).toEqual(['filled']);
    const [runtime] = await asUser((tx) =>
      tx
        .select({ status: schema.strategyRuntimes.status })
        .from(schema.strategyRuntimes)
        .where(eq(schema.strategyRuntimes.id, runtimeId)),
    );
    expect(runtime?.status).toBe('running');
    // The Orders page's list (GET /api/v1/orders) reads Core only.
    const list = await asUser((tx) => listOrders(tx, {}));
    expect(list.orders.length).toBeGreaterThan(0);
    // And the Research database really is gone.
    await expect(t.research!.app.db.execute(sql`select 1`)).rejects.toThrow();
  }, 60_000);

  it('a back test that cannot store its trades fails with a message, never silently', async () => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: 'BT2', definition: alwaysBuy() }),
    );
    const run = await asUser((tx) =>
      startBacktest(tx, userId, s.id, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    );
    const dead = createDb(DEAD_URL, { max: 1 });
    try {
      const outcome = await processNextRun({
        db: t.app.db,
        research: researchStore(t.app.db, dead.db),
        provider: createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') }),
        workerId: 'w-bt2',
        logger: quiet,
      });
      expect(outcome).toBe('failed');
    } finally {
      await dead.close();
    }
    const failed = await asUser((tx) => getBacktest(tx, run.id));
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/Research storage/);
  }, 60_000);
});

describe('A2: with Core stopped', () => {
  it('back tests fail loudly and the paper runtime refuses to step', async () => {
    const dead = createDb(DEAD_URL, { max: 1 });
    try {
      await expect(
        processNextRun({
          db: dead.db,
          research: researchStore(dead.db),
          provider: createDemoHistoryProvider({ now: () => new Date('2026-10-02T21:00:00Z') }),
          workerId: 'w-a2',
          logger: quiet,
        }),
      ).rejects.toThrow();
      // No runtime can be claimed, so no order can be placed without Core.
      await expect(pass(dead.db)).rejects.toThrow();
    } finally {
      await dead.close();
    }
  }, 30_000);
});
