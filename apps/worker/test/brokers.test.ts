import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  claimRuntimes,
  createCredential,
  createFeed,
  createPlatform,
  createStrategy,
  eq,
  generateCredentialKeyPair,
  listPlatforms,
  provisionWorkspace,
  registerInstrument,
  schema,
  startStrategy,
  updateAccount,
  updateStrategy,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDefinition, type PlannedOrder, type StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaBrokerProvider, alpacaProvider } from '../src/alpaca';
import { runBrokerChecks } from '../src/broker-checks';
import type { BrokerRegistry } from '../src/brokers';
import { demoProvider, type ProviderRegistry } from '../src/providers';
import { runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';
import { valueAccount } from '../src/valuations';

/**
 * Trading platforms through the worker (ADR 0018), against the fake Alpaca:
 * a check discovers the paper account, and a strategy's orders go to the
 * account its legs name.
 */

let t: TestDatabase;
let userId: string;
let ztsta: string;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Tuesday 2026-10-06, one minute after the 10:30 New York bar closed. */
let clock = Date.parse('2026-10-06T14:31:00Z');
const now = () => new Date(clock);
const fake = new FakeAlpaca({ now });
const fakeUrls = {
  fetch: fake.fetch,
  fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
};
const providers: ProviderRegistry = { alpaca: alpacaProvider(fakeUrls) };
const brokers: BrokerRegistry = { alpaca: alpacaBrokerProvider(fakeUrls) };

const as = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
// Checks are due by the database's clock, so they record real time, not the trading clock.
const checks = () =>
  runBrokerChecks({
    db: t.worker.db,
    brokers,
    privateKey: keys.privateKey,
    logger: quiet,
    now: () => new Date(),
  });

const runtimeOptions = (): RuntimeWorkerOptions => ({
  db: t.worker.db,
  workerId: 'worker-brokers',
  history: (at) => createDemoHistoryProvider({ now: at }),
  quotes: (at) => createDemoLiveFeed({ now: at }),
  providers: {
    ...providers,
    demo: demoProvider(
      (at) => createDemoLiveFeed({ now: at }),
      (at) => createDemoHistoryProvider({ now: at }),
    ),
  },
  brokers,
  privateKey: keys.privateKey,
  now,
  logger: quiet,
});

async function pass() {
  const claimed = await claimRuntimes(t.worker.db, 'worker-brokers', {
    leaseSeconds: 30,
    limit: 10,
  });
  for (const c of claimed) await runRuntimePass(runtimeOptions(), c.runtimeId, c.userId);
}

async function storeKey(secretKey = fake.credentials.secretKey) {
  return as((tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Alpaca paper',
      fields: { keyId: fake.credentials.keyId, secretKey },
      publicKey: keys.publicKey,
    }),
  );
}

const platform = async (id: string) => (await as(listPlatforms)).find((p) => p.id === id)!;

beforeAll(async () => {
  t = await createTestDatabase();
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Brokers', email: 'brokers@example.test' })
    .returning({ id: schema.users.id });
  userId = row!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Brokers' });
  ztsta = await withTenant(t.worker.db, { userId }, (tx) =>
    registerInstrument(tx, {
      assetClass: 'stock',
      symbol: 'ZTSTA',
      venue: 'NASDAQ',
      displayName: 'Test Alpha Inc. Common Stock',
      provider: 'alpaca',
      providerId: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
    }),
  );
  // The demo platform's own first check, out of the way.
  await checks();
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('broker checks', () => {
  it('reports a refused key without discovering anything', async () => {
    const credential = await storeKey('not-the-right-secret-key-00000000');
    const added = await as((tx) =>
      createPlatform(tx, {
        userId,
        name: 'Wrong key',
        provider: 'alpaca',
        credentialId: credential.id,
      }),
    );
    expect(await checks()).toBe(1);
    expect(await platform(added.id)).toMatchObject({
      health: 'down',
      checking: false,
      accounts: [],
      lastError: 'Alpaca refused the API key. Replace it under Stored API keys.',
    });
  });

  it('discovers the paper account behind the key', async () => {
    const credential = await storeKey();
    const added = await as((tx) =>
      createPlatform(tx, {
        userId,
        name: 'Alpaca',
        provider: 'alpaca',
        credentialId: credential.id,
      }),
    );
    await checks();
    const checked = await platform(added.id);
    expect(checked).toMatchObject({ health: 'healthy', lastError: null });
    expect(checked.accounts).toHaveLength(1);
    expect(checked.accounts[0]).toMatchObject({
      nickname: expect.stringMatching(/^Alpaca paper ••••\d{4}$/),
      mode: 'paper',
      currency: 'USD',
      capabilities: { coverage: 'us', extendedHours: true },
    });
    // Nothing is due again until the next interval.
    expect(await checks()).toBe(0);
  });
});

describe('routing per account', () => {
  it('places and fills a strategy’s order on its Alpaca account', async () => {
    const alpaca = (await as(listPlatforms)).find((p) => p.name === 'Alpaca')!;
    const account = alpaca.accounts[0]!;

    // Prices and bars for US stocks come from Alpaca too.
    // Adding the feed routes them to it.
    await as((tx) =>
      createFeed(tx, {
        userId,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialId: alpaca.credential!.id,
        assetClasses: ['stock', 'etf'],
      }),
    );

    const series = {
      kind: 'market' as const,
      instrumentId: ztsta,
      field: 'close' as const,
      interval: '1h' as const,
      adjustment: 'split_and_dividend' as const,
      session: 'regular' as const,
      offset: 0,
    };
    const condition = (
      id: string,
      operator: 'gt' | 'lt',
    ): StrategyDefinition['entry']['condition'] => ({
      kind: 'group',
      id: `${id}-g`,
      op: 'and',
      negate: false,
      children: [
        {
          kind: 'comparison',
          id,
          operator,
          left: { ...series, id: `${id}-px` },
          right: { kind: 'constant', id: `${id}-k`, value: '1' },
        },
      ],
    });
    const leg = (id: string, side: PlannedOrder['side']): PlannedOrder => ({
      id,
      legLabel: id,
      instrumentId: ztsta,
      accountId: account.id,
      side,
      quantity: { type: 'units', value: '3', rounding: 'down' },
      orderType: 'market',
      timeInForce: 'day',
      timing: { mode: 'immediate' },
    });
    const def = createDefinition();
    def.entry.condition = condition('in', 'gt');
    def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    def.entry.orders = [leg('Buy ZTSTA', 'buy')];
    def.exit.condition = condition('out', 'lt');
    def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    def.exit.orders = [leg('Sell ZTSTA', 'close')];

    const strategy = await as(async (tx) => {
      let s = await createStrategy(tx, userId, { name: 'Alpaca buyer', definition: def });
      s = await updateStrategy(tx, userId, s.id, {
        rowVersion: s.rowVersion,
        status: 'under_testing',
      });
      const { validation } = await validateStoredStrategy(tx, s.id);
      expect(validation.errors).toEqual([]);
      return startStrategy(tx, userId, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: validation.warnings.map((w) => w.code),
      });
    });

    const orders = () =>
      as((tx) =>
        tx
          .select({
            account: schema.orderIntents.accountId,
            state: schema.brokerOrders.state,
            filled: schema.brokerOrders.filledQuantity,
          })
          .from(schema.brokerOrders)
          .innerJoin(schema.orderIntents, eq(schema.orderIntents.id, schema.brokerOrders.intentId))
          .innerJoin(
            schema.strategyRuntimes,
            eq(schema.strategyRuntimes.id, schema.orderIntents.runtimeId),
          )
          .where(eq(schema.strategyRuntimes.strategyId, strategy.id)),
      );

    await pass();
    const sent = await orders();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.account).toBe(account.id);
    expect(fake.requests.some((r) => r.method === 'POST' && r.url.endsWith('/v2/orders'))).toBe(
      true,
    );

    // The fake trades it; the next pass reads the fill back from Alpaca.
    clock += 5_000;
    await fake.tick();
    await pass();
    expect(await orders()).toEqual([{ account: account.id, state: 'filled', filled: '3' }]);

    // Turning the account off pauses the strategy before anything else is sent.
    const current = (await platform(alpaca.id)).accounts[0]!;
    await as((tx) =>
      updateAccount(tx, {
        userId,
        id: current.id,
        rowVersion: current.rowVersion,
        active: false,
        pauseStrategies: true,
      }),
    );
    const [runtime] = await as((tx) =>
      tx
        .select()
        .from(schema.strategyRuntimes)
        .where(eq(schema.strategyRuntimes.strategyId, strategy.id)),
    );
    expect(runtime?.status).toBe('paused');
  });
});

describe('valuation', () => {
  const value = async (accountId: string) =>
    valueAccount(
      { db: t.worker.db, providers, brokers, privateKey: keys.privateKey, logger: quiet, now },
      accountId,
      userId,
    );
  const valuations = (accountId: string) =>
    as((tx) =>
      tx
        .select()
        .from(schema.accountValuations)
        .where(eq(schema.accountValuations.accountId, accountId))
        .orderBy(schema.accountValuations.sessionDate),
    );

  it('values the Alpaca account against the broker and flags what was traded outside the app', async () => {
    const account = (await as(listPlatforms)).find((p) => p.name === 'Alpaca')!.accounts[0]!;

    // During the session: the starting equity comes from Alpaca, so the two agree.
    clock += 60_000;
    await value(account.id);
    const [during] = await valuations(account.id);
    expect(during).toMatchObject({ sessionDate: '2026-10-06', final: false, flagged: false });
    expect(Math.abs(Number(during!.difference))).toBeLessThanOrEqual(0.01);
    expect(during!.startingEquity).not.toBeNull();
    const [book] = await as((tx) =>
      tx
        .select()
        .from(schema.bookValuations)
        .where(eq(schema.bookValuations.accountId, account.id)),
    );
    expect(book).toMatchObject({ instrumentId: ztsta, quantity: '3', markStale: false });

    // Someone buys 2 more straight at Alpaca; the app never sees the order.
    const outside = await fake.fetch(`${FAKE_ALPACA_TRADING_URL}/v2/orders`, {
      method: 'POST',
      headers: {
        'APCA-API-KEY-ID': fake.credentials.keyId,
        'APCA-API-SECRET-KEY': fake.credentials.secretKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        symbol: 'ZTSTA',
        qty: '2',
        side: 'buy',
        type: 'market',
        time_in_force: 'day',
      }),
    });
    expect(outside.status).toBe(200);
    clock += 5_000;
    await fake.tick();

    // After the 4:00 pm close the valuation is final and names the difference.
    clock = Date.parse('2026-10-06T20:05:00Z');
    await value(account.id);
    const [close] = await valuations(account.id);
    expect(close).toMatchObject({ final: true, flagged: true });
    expect(close!.positionDifferences).toEqual([
      { instrumentId: ztsta, symbol: 'ZTSTA', app: '3', broker: '5' },
    ]);
    const notes = await as((tx) =>
      tx
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.kind, 'reconciliation_mismatch')),
    );
    expect(notes.map((n) => n.body).join(' ')).toContain('ZTSTA: app 3, broker 5');

    // The close is kept: valuing again later changes nothing.
    clock += 600_000;
    await value(account.id);
    expect((await valuations(account.id))[0]!.asOf).toEqual(close!.asOf);
  });

  it('values the demo account from its $100,000 start', async () => {
    const demo = (await as(listPlatforms)).find((p) => p.provider === 'demo')!.accounts[0]!;
    await value(demo.id);
    const [row] = await valuations(demo.id);
    expect(row).toMatchObject({
      final: true,
      startingEquity: '100000',
      appEquity: '100000',
      brokerEquity: null,
      flagged: false,
    });
  });
});

describe('market-hours policy', () => {
  it('sends a day limit order before the open under "extended hours if supported" (§6.8)', async () => {
    const off = (await as(listPlatforms)).find((p) => p.name === 'Alpaca')!.accounts[0]!;
    await as((tx) =>
      updateAccount(tx, { userId, id: off.id, rowVersion: off.rowVersion, active: true }),
    );
    // Wednesday 2026-10-07, 8:00 New York: Alpaca's pre-market session.
    clock = Date.parse('2026-10-07T12:00:00Z');

    const close = {
      kind: 'market' as const,
      id: 'px',
      instrumentId: ztsta,
      field: 'close' as const,
      interval: '1h' as const,
      adjustment: 'split_and_dividend' as const,
      session: 'regular' as const,
      offset: 0,
    };
    const leg = (id: string, side: PlannedOrder['side']): PlannedOrder => ({
      id,
      legLabel: id,
      instrumentId: ztsta,
      accountId: off.id,
      side,
      quantity: { type: 'units', value: '2', rounding: 'down' },
      orderType: 'limit',
      limitPrice: {
        kind: 'calc',
        id: `${id}-lim`,
        op: 'mul',
        args: [
          { ...close, id: `${id}-c` },
          { kind: 'constant', id: `${id}-k`, value: '1.01' },
        ],
      },
      timeInForce: 'day',
      timing: { mode: 'immediate' },
    });
    const group = (id: string, operator: 'gt' | 'lt') => ({
      kind: 'group' as const,
      id: `${id}-g`,
      op: 'and' as const,
      negate: false,
      children: [
        {
          kind: 'comparison' as const,
          id,
          operator,
          left: { ...close, id: `${id}-px` },
          right: { kind: 'constant' as const, id: `${id}-k`, value: '1' },
        },
      ],
    });
    const def = createDefinition();
    def.execution.marketHoursPolicy = 'extended_if_supported';
    def.entry.condition = group('in', 'gt');
    def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    def.entry.orders = [leg('Buy early', 'buy')];
    def.exit.condition = group('out', 'lt');
    def.exit.orders = [leg('Sell early', 'sell')];

    const strategy = await as(async (tx) => {
      let s = await createStrategy(tx, userId, { name: 'Early bird', definition: def });
      s = await updateStrategy(tx, userId, s.id, {
        rowVersion: s.rowVersion,
        status: 'under_testing',
      });
      const { validation } = await validateStoredStrategy(tx, s.id);
      expect(validation.errors).toEqual([]);
      expect(validation.warnings.map((w) => w.code)).not.toContain('extended_hours_policy_waits');
      return startStrategy(tx, userId, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: validation.warnings.map((w) => w.code),
      });
    });

    await pass();
    const intents = await as((tx) =>
      tx
        .select({ extendedHours: schema.orderIntents.extendedHours })
        .from(schema.orderIntents)
        .innerJoin(
          schema.strategyRuntimes,
          eq(schema.strategyRuntimes.id, schema.orderIntents.runtimeId),
        )
        .where(eq(schema.strategyRuntimes.strategyId, strategy.id)),
    );
    expect(intents).toHaveLength(1);
    expect(intents[0]?.extendedHours).toBe(true);
  });
});
