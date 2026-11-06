import {
  claimRuntimes,
  createCredential,
  createFeed,
  createStrategy,
  deleteFeed,
  eq,
  generateCredentialKeyPair,
  getFeed,
  listFeeds,
  listNotifications,
  listRoutes,
  provisionWorkspace,
  schema,
  setFeedActive,
  startStrategy,
  updateRoute,
  updateStrategy,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDefinition, type PlannedOrder, type StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runFeedChecks } from '../src/feed-checks';
import { demoProvider, type MarketDataProvider, type ProviderRegistry } from '../src/providers';
import { runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';

/**
 * Data feeds and routes (§9.2, §9.4; ADR 0016): feed checks, failover to the
 * fallback feed and back, and the rules for turning off a feed in use.
 */

let t: TestDatabase;
let userId: string;
let demoA: string;
let account: string;
let demoFeed: string;
const keys = generateCredentialKeyPair();
const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Tuesday 2026-10-06, one minute after the 10:30 New York bar closed. */
const T0 = Date.parse('2026-10-06T14:31:00Z');
let clock = T0;

/** A stand-in provider whose outage the tests control. */
let flakyDown = false;
const flaky: MarketDataProvider = {
  needsCredential: false,
  quotes: ({ now }) => {
    const feed = createDemoLiveFeed({ now });
    return {
      id: 'flaky',
      latestQuote: async (ref) => (flakyDown ? undefined : feed.latestQuote(ref)),
    };
  },
  history: ({ now }) => createDemoHistoryProvider({ now }),
  check: async () =>
    flakyDown
      ? { ok: false, entitlement: 'unknown', error: 'Test outage' }
      : { ok: true, entitlement: 'entitled', realtime: true },
};

const demoQuotes = (now: () => Date) => createDemoLiveFeed({ now });
const demoHistory = (now: () => Date) => createDemoHistoryProvider({ now });
const providers: ProviderRegistry = { demo: demoProvider(demoQuotes, demoHistory), flaky };

const options = (workerId: string): RuntimeWorkerOptions => ({
  db: t.worker.db,
  workerId,
  history: (now) => createDemoHistoryProvider({ now }),
  quotes: demoQuotes,
  providers,
  privateKey: keys.privateKey,
  now: () => new Date(clock),
  logger: quiet,
});

async function pass(workerId = 'worker-1') {
  const claimed = await claimRuntimes(t.worker.db, workerId, { leaseSeconds: 30, limit: 10 });
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

const group = (id: string, operator: 'gt' | 'lt'): StrategyDefinition['entry']['condition'] => ({
  kind: 'group',
  id: `${id}-g`,
  op: 'and',
  negate: false,
  children: [
    {
      kind: 'comparison',
      id,
      operator,
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

/** Buys DEMO-A at once and never exits. */
async function startBuyer(name: string) {
  return asUser(async (tx) => {
    const def = createDefinition();
    def.entry.condition = group('in', 'gt');
    def.entry.trigger = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };
    def.exit.condition = group('out', 'lt');
    def.exit.trigger = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };
    def.entry.orders = [leg('buy', { legLabel: 'Buy A' })];
    def.exit.orders = [leg('sell', { legLabel: 'Sell A', side: 'close' })];
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
    return { strategyId: s.id, runtimeId: runtime!.id };
  });
}

const stockDemoRoute = async () =>
  (await asUser((tx) => listRoutes(tx))).find(
    (r) => r.assetClass === 'stock' && r.venue === 'DEMO' && r.dataType === 'quotes',
  )!;

const notices = async () =>
  (await asUser((tx) => listNotifications(tx, { limit: 200 }))).notifications.map((n) => n.title);

const filledBuys = async (runtimeId: string) =>
  asUser((tx) =>
    tx
      .select({ state: schema.brokerOrders.state })
      .from(schema.orderIntents)
      .innerJoin(schema.brokerOrders, eq(schema.brokerOrders.intentId, schema.orderIntents.id))
      .where(eq(schema.orderIntents.runtimeId, runtimeId)),
  );

async function stopAll() {
  await t.ownerSql`update strategy_runtime set status = 'stopped', stopped_at = now() where status <> 'stopped'`;
  await t.ownerSql`update broker_order set state = 'canceled', terminal_at = now() where state in ('ready', 'submitted', 'acknowledged', 'partially_filled')`;
  await t.ownerSql`update execution_incident set resolved_at = now(), resolved_by = 'system' where resolved_at is null`;
  flakyDown = false;
}

beforeAll(async () => {
  t = await createTestDatabase();
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Feeds', email: 'feeds@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Feeds' });
  const rows = await t.owner.db.select().from(schema.instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
  demoFeed = (await asUser((tx) => listFeeds(tx))).find((f) => f.provider === 'demo')!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await stopAll();
  clock = T0;
});

describe('routes', () => {
  it('provisions demo routes on the demo venue, and keeps demo and real feeds apart', async () => {
    const backup = await asUser((tx) =>
      createFeed(tx, { userId, name: 'Demo backup', provider: 'demo', assetClasses: ['stock'] }),
    );
    // A new demo feed backs up the demo routes on its own.
    const route = await stockDemoRoute();
    expect(route).toMatchObject({ primary: { id: demoFeed }, fallback: { id: backup.id } });
    // A second demo feed can back up the first, and changing the primary is audited (§9.4).
    const moved = await asUser((tx) =>
      updateRoute(tx, {
        userId,
        id: route.id,
        rowVersion: route.rowVersion,
        primaryFeedId: backup.id,
        fallbackFeedId: demoFeed,
      }),
    );
    expect(moved).toMatchObject({ primary: { id: backup.id }, fallback: { id: demoFeed } });
    const audit = await t.owner.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.resourceId, route.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['data_route.primary_changed', 'data_route.fallback_changed']),
    );

    // An Alpaca feed cannot serve the invented demo instruments.
    const cred = await asUser((tx) =>
      createCredential(tx, {
        userId,
        provider: 'alpaca',
        label: 'Paper key',
        fields: { keyId: 'PKROUTETEST0000001', secretKey: 'route-test-secret-0000001' },
        publicKey: keys.publicKey,
      }),
    );
    const alpaca = await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialId: cred.id,
        assetClasses: ['stock', 'etf'],
      }),
    );
    await expect(
      asUser((tx) =>
        updateRoute(tx, {
          userId,
          id: route.id,
          rowVersion: moved.rowVersion,
          primaryFeedId: alpaca.id,
          fallbackFeedId: null,
        }),
      ),
    ).rejects.toThrow(/Demo instruments can only use a demo feed/);

    // Put things back for the other tests.
    await asUser((tx) =>
      updateRoute(tx, {
        userId,
        id: route.id,
        rowVersion: moved.rowVersion,
        primaryFeedId: demoFeed,
        fallbackFeedId: null,
      }),
    );
    await asUser((tx) => deleteFeed(tx, { userId, id: backup.id }));
    await asUser((tx) => deleteFeed(tx, { userId, id: alpaca.id }));
  });

  it('routes US stocks and ETFs to a new real feed, and removes those routes with it', async () => {
    const before = await asUser((tx) => listRoutes(tx));
    const cred = await asUser((tx) =>
      createCredential(tx, {
        userId,
        provider: 'alpaca',
        label: 'Auto routes key',
        fields: { keyId: 'PKAUTOROUTE0000001', secretKey: 'auto-route-secret-0000001' },
        publicKey: keys.publicKey,
      }),
    );
    const alpaca = await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'Alpaca auto',
        provider: 'alpaca',
        credentialId: cred.id,
        assetClasses: ['stock', 'etf'],
      }),
    );
    const added = (await asUser((tx) => listRoutes(tx))).filter((r) => r.primary.id === alpaca.id);
    expect(added.map((r) => `${r.assetClass}/${r.venue ?? 'any'}/${r.dataType}`).sort()).toEqual([
      'etf/any/bars',
      'etf/any/quotes',
      'stock/any/bars',
      'stock/any/quotes',
    ]);
    expect(added.every((r) => r.fallback === null)).toBe(true);
    // The demo routes are untouched.
    const after = await asUser((tx) => listRoutes(tx));
    for (const r of before) expect(after.find((a) => a.id === r.id)?.primary.id).toBe(r.primary.id);

    // A second real feed gets no routes of its own; it backs up the first feed's routes.
    const second = await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'Alpaca second',
        provider: 'alpaca',
        credentialId: cred.id,
        assetClasses: ['stock'],
      }),
    );
    expect(second.routes.map((r) => `${r.role}:${r.assetClass}/${r.dataType}`).sort()).toEqual([
      'fallback:stock/bars',
      'fallback:stock/quotes',
    ]);

    // Removing the first feed deletes all its routes; the second gets its own in their place.
    const firstRoutes = added.map((r) => r.id);
    await asUser((tx) => deleteFeed(tx, { userId, id: alpaca.id }));
    const left = await asUser((tx) => listRoutes(tx));
    expect(left.some((r) => firstRoutes.includes(r.id))).toBe(false);
    const now = await asUser((tx) => getFeed(tx, second.id));
    expect(
      now.routes.map((r) => `${r.role}:${r.assetClass}/${r.venue ?? 'any'}/${r.dataType}`).sort(),
    ).toEqual(['primary:stock/any/bars', 'primary:stock/any/quotes']);

    // Removing the last one leaves the routing as it was.
    await asUser((tx) => deleteFeed(tx, { userId, id: second.id }));
    const remaining = await asUser((tx) => listRoutes(tx));
    expect(remaining.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
  });

  it('makes a new demo feed the backup for demo routes, and takes it off them when removed', async () => {
    const spare = await asUser((tx) =>
      createFeed(tx, { userId, name: 'Demo extra', provider: 'demo', assetClasses: ['stock'] }),
    );
    expect(
      spare.routes.map((r) => `${r.role}:${r.assetClass}/${r.venue}/${r.dataType}`).sort(),
    ).toEqual(['fallback:stock/DEMO/bars', 'fallback:stock/DEMO/quotes']);
    await asUser((tx) => deleteFeed(tx, { userId, id: spare.id }));
    const routes = await asUser((tx) => listRoutes(tx));
    expect(routes.every((r) => r.primary.id === demoFeed && r.fallback === null)).toBe(true);
  });

  it('refuses a feed for an asset class it does not cover, or a key for another provider', async () => {
    await expect(
      asUser((tx) =>
        createFeed(tx, { userId, name: 'X', provider: 'demo', assetClasses: ['crypto'] }),
      ),
    ).rejects.toThrow(/covers stock and etf/);
    await expect(
      asUser((tx) =>
        createFeed(tx, { userId, name: 'X', provider: 'alpaca', assetClasses: ['stock'] }),
      ),
    ).rejects.toThrow(/Choose or add an API key for Alpaca/);
  });
});

describe('feed checks', () => {
  it('tests a new feed at once, opening its stored key only in the worker', async () => {
    const cred = await asUser((tx) =>
      createCredential(tx, {
        userId,
        provider: 'alpaca',
        label: 'Check key',
        fields: { keyId: 'PKCHECKTEST000001', secretKey: 'check-test-secret-000001' },
        publicKey: keys.publicKey,
      }),
    );
    const feed = await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'Alpaca check',
        provider: 'alpaca',
        credentialId: cred.id,
        assetClasses: ['stock'],
      }),
    );
    expect(feed).toMatchObject({ checking: true, health: 'unknown' });

    // Without an adapter yet, the check says so rather than pretending.
    await runFeedChecks({ db: t.worker.db, providers, privateKey: keys.privateKey, logger: quiet });
    let checked = await asUser((tx) => getFeed(tx, feed.id));
    expect(checked).toMatchObject({
      checking: false,
      health: 'down',
      lastError: 'This provider is not available yet',
    });

    // With an adapter, it receives the stored key's values, and only it does.
    let seen: Record<string, string> | undefined;
    const alpaca: MarketDataProvider = {
      needsCredential: true,
      quotes: () => ({ id: 'x', latestQuote: async () => undefined }),
      history: ({ now }) => createDemoHistoryProvider({ now }),
      check: async ({ credential }) => {
        seen = credential?.fields;
        return { ok: true, entitlement: 'entitled', realtime: true };
      },
    };
    await asUser((tx) =>
      tx
        .update(schema.dataFeedConnections)
        .set({ checkRequestedAt: new Date() })
        .where(eq(schema.dataFeedConnections.id, feed.id)),
    );
    await runFeedChecks({
      db: t.worker.db,
      providers: { ...providers, alpaca },
      privateKey: keys.privateKey,
      logger: quiet,
    });
    expect(seen).toEqual({ keyId: 'PKCHECKTEST000001', secretKey: 'check-test-secret-000001' });
    checked = await asUser((tx) => getFeed(tx, feed.id));
    expect(checked).toMatchObject({ health: 'healthy', entitlement: 'entitled', lastError: null });
    expect(checked.lastSuccessAt).not.toBeNull();

    // A provider failure is recorded without its raw message.
    const broken: MarketDataProvider = {
      ...alpaca,
      check: async () => {
        throw new Error('401 Unauthorized: key PKCHECKTEST000001');
      },
    };
    await asUser((tx) =>
      tx
        .update(schema.dataFeedConnections)
        .set({ checkRequestedAt: new Date() })
        .where(eq(schema.dataFeedConnections.id, feed.id)),
    );
    await runFeedChecks({
      db: t.worker.db,
      providers: { ...providers, alpaca: broken },
      privateKey: keys.privateKey,
      logger: quiet,
    });
    checked = await asUser((tx) => getFeed(tx, feed.id));
    expect(checked).toMatchObject({
      health: 'down',
      lastError: 'The provider could not be reached',
    });
    expect(await notices()).toContain('Alpaca check is not responding');
    await asUser((tx) => deleteFeed(tx, { userId, id: feed.id }));
  });
});

describe('failover', () => {
  it('switches a route to its fallback when the primary goes quiet, and back after it recovers', async () => {
    // A primary on a provider the test can take down, with the demo feed as fallback.
    const [flakyFeed] = await t.owner.db
      .insert(schema.dataFeedConnections)
      .values({ userId, name: 'Flaky feed', provider: 'flaky', assetClasses: ['stock'] })
      .returning({ id: schema.dataFeedConnections.id });
    const route = await stockDemoRoute();
    await t.ownerSql`update data_route set primary_feed_id = ${flakyFeed!.id}, fallback_feed_id = ${demoFeed} where id = ${route.id}`;

    const { runtimeId } = await startBuyer('Routed buyer');
    await pass();
    clock += 5_000;
    await pass();
    expect((await filledBuys(runtimeId)).map((o) => o.state)).toEqual(['filled']);
    expect((await stockDemoRoute()).activeSource).toBe('primary');

    // The primary stops answering: prices come from the fallback, nothing pauses.
    flakyDown = true;
    for (let i = 0; i < 4; i += 1) {
      clock += 60_000;
      await pass();
    }
    expect(await stockDemoRoute()).toMatchObject({ activeSource: 'fallback' });
    const [status] = await asUser((tx) =>
      tx
        .select({ status: schema.strategyRuntimes.status })
        .from(schema.strategyRuntimes)
        .where(eq(schema.strategyRuntimes.id, runtimeId)),
    );
    expect(status!.status).toBe('running');
    expect(await notices()).toContain('Prices switched to Demo feed');

    // The primary comes back, but prices stay on the fallback until it has been
    // healthy for five minutes.
    flakyDown = false;
    clock += 60_000;
    await pass();
    expect((await stockDemoRoute()).activeSource).toBe('fallback');
    clock += 4 * 60_000;
    await pass();
    expect((await stockDemoRoute()).activeSource).toBe('fallback');
    clock += 60_000 + 1_000;
    await pass();
    expect((await stockDemoRoute()).activeSource).toBe('primary');
    expect(await notices()).toContain('Prices are back on Flaky feed');

    const audit = await t.owner.db
      .select({ action: schema.auditEvents.action })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.resourceId, route.id));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['data_route.failed_over', 'data_route.switched_back']),
    );

    await t.ownerSql`update data_route set primary_feed_id = ${demoFeed}, fallback_feed_id = null, active_source = 'primary' where id = ${route.id}`;
    await t.ownerSql`delete from data_feed_connection where id = ${flakyFeed!.id}`;
  });
});

describe('turning off a feed in use (§9.4)', () => {
  it('needs a replacement feed or pausing the strategies that use it', async () => {
    const { runtimeId } = await startBuyer('Depends on demo');
    const backup = await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'Demo spare',
        provider: 'demo',
        assetClasses: ['stock', 'etf'],
      }),
    );

    const refused = await asUser((tx) =>
      setFeedActive(tx, { userId, id: demoFeed, active: false }),
    ).then(
      () => undefined,
      (e: unknown) => e as { code?: string; details?: { dependents: { strategyName: string }[] } },
    );
    expect(refused?.code).toBe('invalid_state');
    expect(refused?.details?.dependents.map((d) => d.strategyName)).toEqual(['Depends on demo']);

    // With a replacement, every route moves over and the strategy keeps running.
    const off = await asUser((tx) =>
      setFeedActive(tx, { userId, id: demoFeed, active: false, replacementFeedId: backup.id }),
    );
    expect(off).toMatchObject({ isActive: false, routes: [] });
    const routes = await asUser((tx) => listRoutes(tx));
    expect(routes.every((r) => r.primary.id === backup.id)).toBe(true);
    clock += 5_000;
    await pass();
    expect((await filledBuys(runtimeId)).length).toBeGreaterThan(0);

    // Turning off the replacement too, choosing to pause, pauses the strategy.
    await asUser((tx) => setFeedActive(tx, { userId, id: demoFeed, active: true }));
    const spare = await asUser((tx) =>
      setFeedActive(tx, { userId, id: backup.id, active: false, pauseStrategies: true }),
    );
    expect(spare.isActive).toBe(false);
    const [status] = await asUser((tx) =>
      tx
        .select({
          status: schema.strategyRuntimes.status,
          reason: schema.strategyRuntimes.pauseReason,
        })
        .from(schema.strategyRuntimes)
        .where(eq(schema.strategyRuntimes.id, runtimeId)),
    );
    expect(status).toEqual({
      status: 'paused',
      reason: 'Its data feed Demo spare was turned off.',
    });

    // Removing it deletes its routes; the demo feed, back on, gets them again.
    await asUser((tx) => deleteFeed(tx, { userId, id: backup.id }));
    const restored = await asUser((tx) => listRoutes(tx));
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.every((r) => r.primary.id === demoFeed && r.fallback === null)).toBe(true);
  });
});
