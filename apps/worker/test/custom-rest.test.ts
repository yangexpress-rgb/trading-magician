import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  createCredential,
  createFeed,
  createStrategy,
  deleteFeed,
  generateCredentialKeyPair,
  getBacktest,
  getCustomFeedTest,
  getFeed,
  listFeeds,
  listNotifications,
  listRoutes,
  loadRouting,
  provisionWorkspace,
  registerInstrument,
  requestCustomFeedTest,
  schema,
  startBacktest,
  updateFeed,
  updateRoute,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider } from '../src/alpaca';
import { processNextRun } from '../src/backtests';
import { runCustomFeedTests } from '../src/custom-feed-tests';
import { customRestProvider } from '../src/custom-rest';
import { FAKE_CUSTOM_CONFIG, FAKE_CUSTOM_KEY, fakeCustomTransport } from '../src/custom-rest-fake';
import { guardedLookup, isBlockedAddress, type Transport } from '../src/custom-rest-transport';
import { runFeedChecks } from '../src/feed-checks';
import { demoProvider, type ProviderRegistry } from '../src/providers';
import { createRoutedHistory } from '../src/routed-history';
import { createRoutedQuotes } from '../src/routed-quotes';

/**
 * Custom REST (JSON) feeds (v1.2 N17; ADR 0041), end to end against a
 * made-up JSON API and the fake Alpaca: test before saving, isolation,
 * routing bars through the feed, cache and limits, health checks and
 * failover, a back test on its bars, and removal back to Alpaca.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let etf: string;
let account: string;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Tuesday 2026-10-06, 11:00 New York. */
let clock = Date.parse('2026-10-06T15:00:00Z');
const now = () => new Date(clock);
const fakeAlpaca = new FakeAlpaca({ now });

/** The made-up API, with a switch for outages and a count of what it was asked. */
const asked: URL[] = [];
let down = false;
const fake = fakeCustomTransport({
  now,
  symbols: ['SPY', 'ZTSTX'],
  onRequest: (u) => asked.push(u),
});
const transport: Transport = async (req) => {
  if (down) return { status: 503, headers: {}, body: 'maintenance' };
  return fake(req);
};

const providers: ProviderRegistry = {
  demo: demoProvider(
    (n) => createDemoLiveFeed({ now: n }),
    (n) => createDemoHistoryProvider({ now: n }),
  ),
  alpaca: alpacaProvider({
    fetch: fakeAlpaca.fetch,
    fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
  }),
  custom_rest: customRestProvider({ transport }),
};

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asWorker = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.worker.db, { userId }, fn);
const tests = () =>
  runCustomFeedTests({
    db: t.worker.db,
    privateKey: keys.privateKey,
    logger: quiet,
    transport,
    now,
  });
const checks = () =>
  runFeedChecks({
    db: t.worker.db,
    providers,
    privateKey: keys.privateKey,
    logger: quiet,
    now,
    customTransport: transport,
  });

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Custom', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Custom' });
  return row!.id;
}

const customKey = (userId: string, apiKey = FAKE_CUSTOM_KEY) =>
  as(userId, (tx) =>
    createCredential(tx, {
      userId,
      provider: 'custom_rest',
      label: 'Prices key',
      fields: { apiKey },
      publicKey: keys.publicKey,
    }),
  );

async function runTest(
  userId: string,
  credentialId: string | null,
  config: unknown = FAKE_CUSTOM_CONFIG,
  symbol = 'SPY',
) {
  const started = await as(userId, (tx) =>
    requestCustomFeedTest(tx, { userId, config, credentialId, symbol }),
  );
  await tests();
  return as(userId, (tx) => getCustomFeedTest(tx, started.id));
}

const barsRequest = (from = '2026-09-01', to = '2026-09-30') => ({
  instrumentId: etf,
  symbol: 'ZTSTX',
  assetClass: 'etf',
  interval: '1d' as const,
  from,
  to,
  adjustment: 'split_and_dividend' as const,
  session: 'regular' as const,
});

const history = (userId: string) =>
  createRoutedHistory({
    inTenant: (fn) => withTenant(t.worker.db, { userId }, fn),
    userId,
    now,
    providers,
    privateKey: keys.privateKey,
  });

let customFeedId: string;
let customCredentialId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('custom-a@example.test');
  userB = await createUser('custom-b@example.test');
  // Alpaca first, as Yong has it: its routes exist before the custom feed arrives.
  await as(userA, async (tx) => {
    const credential = await createCredential(tx, {
      userId: userA,
      provider: 'alpaca',
      label: 'Alpaca paper',
      fields: { keyId: fakeAlpaca.credentials.keyId, secretKey: fakeAlpaca.credentials.secretKey },
      publicKey: keys.publicKey,
    });
    await createFeed(tx, {
      userId: userA,
      name: 'Alpaca prices',
      provider: 'alpaca',
      credentialId: credential.id,
      assetClasses: ['stock', 'etf'],
    });
  });
  etf = await asWorker(userA, (tx) =>
    registerInstrument(tx, {
      assetClass: 'etf',
      symbol: 'ZTSTX',
      venue: 'ARCA',
      displayName: 'Test Broad Market ETF',
      provider: 'alpaca',
      providerId: '1c2d3e4f-0000-4000-8000-00000000000c',
    }),
  );
  account = (await as(userA, (tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
  // With demo data off, as in deployments, the built-in paper account trades real US listings (ADR 0039).
  await t.ownerSql`update trading_account set capabilities = jsonb_set(capabilities, '{coverage}', '"us"') where id = ${account}`;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('connections are guarded', () => {
  it('refuses private and local addresses after the name is resolved', async () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '151.101.1.1', '2606:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
    const looked = await new Promise<Error | null>((resolve) =>
      guardedLookup('localhost', {}, (err) => resolve(err)),
    );
    expect(looked?.message).toMatch(/private or local network/);
  });
});

describe('testing before saving', () => {
  it('cannot save a custom feed without a passing test', async () => {
    const key = await customKey(userA);
    customCredentialId = key.id;
    await expect(
      as(userA, (tx) =>
        createFeed(tx, {
          userId: userA,
          name: 'My prices',
          provider: 'custom_rest',
          assetClasses: ['stock', 'etf'],
          credentialId: key.id,
          config: FAKE_CUSTOM_CONFIG,
        }),
      ),
    ).rejects.toThrow(/Test the feed before saving it/);
  });

  it('fetches one symbol, maps it and shows what it read', async () => {
    const test = await runTest(userA, customCredentialId);
    expect(test.status).toBe('succeeded');
    expect(test.result).toMatchObject({
      symbol: 'SPY',
      bars: { first: '2026-09-08', last: '2026-10-05' },
      quote: { at: '2026-10-06T15:00:00.000Z' },
    });
    expect(test.result!.bars.count).toBeGreaterThan(18);
    expect(test.result!.bars.sample).toHaveLength(5);
    // The key is never shown, not even in the URLs it was sent to.
    expect(JSON.stringify(test)).not.toContain(FAKE_CUSTOM_KEY);
    expect(test.result!.bars.url).toBe(
      'https://prices.example.test/v1/daily?symbol=SPY&start=2026-09-05&end=2026-10-06&token=••••',
    );
  });

  it('gives the exact reason a test fails, without the key', async () => {
    const wrong = await customKey(userA, 'not-the-key');
    const refused = await runTest(userA, wrong.id);
    expect(refused).toMatchObject({ status: 'failed' });
    expect(refused.message).toBe(
      'Daily bars: prices.example.test answered HTTP 401 (the key was refused or lacks access): {"error":"invalid token"}',
    );
    const mapping = await runTest(userA, customCredentialId, {
      ...FAKE_CUSTOM_CONFIG,
      bars: { ...FAKE_CUSTOM_CONFIG.bars, close: 'data.bars[].last' },
    });
    expect(mapping.message).toBe(
      'Bar 1: the answer has no “last” (it has date, open, high, low, close, volume)',
    );
    const unknown = await runTest(userA, customCredentialId, FAKE_CUSTOM_CONFIG, 'NOPE');
    expect(unknown.message).toMatch(/HTTP 404 \(not found: check the URL and symbol\)/);
    // Settings that cannot work are refused before anything is fetched.
    await expect(
      runTest(userA, customCredentialId, {
        ...FAKE_CUSTOM_CONFIG,
        baseUrl: 'https://192.168.0.10',
      }),
    ).rejects.toThrow(/not an IP address/);
  });

  it('saves once tested, only with the tested settings', async () => {
    const test = await runTest(userA, customCredentialId);
    await expect(
      as(userA, (tx) =>
        createFeed(tx, {
          userId: userA,
          name: 'My prices',
          provider: 'custom_rest',
          assetClasses: ['stock', 'etf'],
          credentialId: customCredentialId,
          config: { ...FAKE_CUSTOM_CONFIG, testSymbol: 'QQQ' },
          testId: test.id,
        }),
      ),
    ).rejects.toThrow(/settings changed since the last test/);
    const feed = await as(userA, (tx) =>
      createFeed(tx, {
        userId: userA,
        name: 'My prices',
        provider: 'custom_rest',
        assetClasses: ['stock', 'etf'],
        credentialId: customCredentialId,
        config: FAKE_CUSTOM_CONFIG,
        testId: test.id,
      }),
    );
    customFeedId = feed.id;
    expect(feed.config?.baseUrl).toBe('https://prices.example.test/v1');
    // Alpaca already had every route, so the new feed backs them up.
    expect(feed.routes.map((r) => `${r.assetClass} ${r.dataType} ${r.role}`).sort()).toEqual([
      'etf bars fallback',
      'etf quotes fallback',
      'stock bars fallback',
      'stock quotes fallback',
    ]);
    // A rename needs no new test; new settings do.
    const renamed = await as(userA, (tx) =>
      updateFeed(tx, {
        userId: userA,
        id: feed.id,
        rowVersion: feed.rowVersion,
        name: 'Custom prices',
      }),
    );
    await expect(
      as(userA, (tx) =>
        updateFeed(tx, {
          userId: userA,
          id: feed.id,
          rowVersion: renamed.rowVersion,
          config: {
            ...FAKE_CUSTOM_CONFIG,
            limits: { ...FAKE_CUSTOM_CONFIG.limits, requestsPerMinute: 5 },
          },
        }),
      ),
    ).rejects.toThrow(/Test the feed before saving it/);
  });

  it('keeps one person’s feed, settings, tests and key to themselves', async () => {
    const theirs = await as(userB, (tx) => listFeeds(tx));
    expect(theirs.filter((f) => f.provider === 'custom_rest')).toEqual([]);
    const test = await runTest(userA, customCredentialId);
    await expect(as(userB, (tx) => getCustomFeedTest(tx, test.id))).rejects.toThrow(/not found/);
    await expect(
      as(userB, (tx) =>
        requestCustomFeedTest(tx, {
          userId: userB,
          config: FAKE_CUSTOM_CONFIG,
          credentialId: customCredentialId,
        }),
      ),
    ).rejects.toThrow(/no longer exists/);
    const raw =
      await t.ownerSql`select config::text as c from data_feed_connection where id = ${customFeedId}`;
    expect(raw[0]!.c).not.toContain(FAKE_CUSTOM_KEY);
  });
});

describe('routing through a custom feed', () => {
  it('serves daily bars once it is made the primary, from the database cache after the first fetch', async () => {
    const routes = await as(userA, (tx) => listRoutes(tx));
    const bars = routes.find(
      (r) => r.assetClass === 'etf' && r.venue === null && r.dataType === 'bars',
    )!;
    await as(userA, (tx) =>
      updateRoute(tx, {
        userId: userA,
        id: bars.id,
        rowVersion: bars.rowVersion,
        primaryFeedId: customFeedId,
        fallbackFeedId: bars.primary.id,
      }),
    );
    asked.length = 0;
    const first = await history(userA).getBars(barsRequest());
    expect(first.bars).toHaveLength(21);
    expect(first.dataVersion).toMatch(/^custom-/);
    expect(first.warnings.join(' ')).toMatch(/prices\.example\.test/);
    expect(asked).toHaveLength(1);
    // Another worker pass, a new history: answered from the database.
    const again = await history(userA).getBars(barsRequest('2026-09-08', '2026-09-20'));
    expect(asked).toHaveLength(1);
    expect(again.dataVersion).toMatch(/^custom-/);
    expect(again.bars.length).toBeLessThan(first.bars.length);
    const cached =
      await t.ownerSql`select count(*)::int as n from custom_feed_cache where feed_id = ${customFeedId}`;
    expect(cached[0]!.n).toBeGreaterThan(0);
  });

  it('asks the backup for intervals it lacks, and when it is held back by its limit', async () => {
    const hourly = await history(userA).getBars({ ...barsRequest(), interval: '1h' });
    expect(hourly.dataVersion).toMatch(/^alpaca-iex-/);
    expect(hourly.warnings[0]).toMatch(
      /backup feed Alpaca prices because Custom prices could not give them: .*daily bars only/,
    );

    const feed = await as(userA, (tx) => getFeed(tx, customFeedId));
    const tight = {
      ...FAKE_CUSTOM_CONFIG,
      limits: { ...FAKE_CUSTOM_CONFIG.limits, requestsPerMinute: 1 },
    };
    const test = await runTest(userA, customCredentialId, tight);
    await as(userA, (tx) =>
      updateFeed(tx, {
        userId: userA,
        id: customFeedId,
        rowVersion: feed.rowVersion,
        config: tight,
        testId: test.id,
      }),
    );
    clock += 60_000;
    asked.length = 0;
    const one = await history(userA).getBars(barsRequest('2026-08-03', '2026-08-31'));
    expect(one.dataVersion).toMatch(/^custom-/);
    const two = await history(userA).getBars(barsRequest('2026-07-01', '2026-07-31'));
    expect(asked).toHaveLength(1);
    expect(two.dataVersion).toMatch(/^alpaca-iex-/);
    expect(two.warnings[0]).toMatch(/Held back: its limit of 1 requests a minute is used up/);
    // Back to the default limit for the rest.
    const relaxed = await runTest(userA, customCredentialId);
    const current = await as(userA, (tx) => getFeed(tx, customFeedId));
    await as(userA, (tx) =>
      updateFeed(tx, {
        userId: userA,
        id: customFeedId,
        rowVersion: current.rowVersion,
        config: FAKE_CUSTOM_CONFIG,
        testId: relaxed.id,
      }),
    );
  });

  it('is health-checked, and its quotes fail over to the backup and are announced', async () => {
    clock += 60_000;
    await checks();
    expect((await as(userA, (tx) => getFeed(tx, customFeedId))).health).toBe('healthy');

    const routes = await as(userA, (tx) => listRoutes(tx));
    const quotes = routes.find(
      (r) => r.assetClass === 'etf' && r.venue === null && r.dataType === 'quotes',
    )!;
    await as(userA, (tx) =>
      updateRoute(tx, {
        userId: userA,
        id: quotes.id,
        rowVersion: quotes.rowVersion,
        primaryFeedId: customFeedId,
        fallbackFeedId: quotes.primary.id,
      }),
    );
    const quote = () =>
      asWorker(userA, async (tx) =>
        createRoutedQuotes({
          tx,
          userId: userA,
          now: now(),
          routing: await loadRouting(tx),
          providers,
          privateKey: keys.privateKey,
          logger: quiet,
        }).latestQuote({ instrumentId: etf, symbol: 'ZTSTX' }),
      );
    expect((await quote())?.source).toBe('custom-rest');

    down = true;
    clock += 60_000;
    expect((await quote())?.source).toBe('alpaca-iex');
    await checks();
    const feed = await as(userA, (tx) => getFeed(tx, customFeedId));
    expect(feed.health).toBe('down');
    expect(feed.lastError).toBe('prices.example.test answered HTTP 503: maintenance');
    const notes = await as(userA, (tx) => listNotifications(tx, { limit: 20 }));
    expect(notes.notifications.map((n) => n.title)).toEqual(
      expect.arrayContaining([
        'Prices switched to Alpaca prices',
        'Custom prices is not responding',
      ]),
    );
    const audit =
      await t.ownerSql`select action from audit_event where user_id = ${userA} and action = 'data_route.failed_over'`;
    expect(audit).toHaveLength(1);
    down = false;
  });

  it('back-tests a strategy on its daily bars', async () => {
    const strategy = await as(userA, (tx) =>
      createStrategy(tx, userA, { name: 'ZTSTX trend', definition: trend() }),
    );
    const { validation } = await as(userA, (tx) => validateStoredStrategy(tx, strategy.id));
    expect(validation.errors).toEqual([]);
    const run = await as(userA, (tx) =>
      startBacktest(tx, userA, strategy.id, {
        ...DEFAULT_BACKTEST_INPUTS,
        from: '2026-03-02',
        to: '2026-09-30',
      }),
    );
    const outcome = await processNextRun({
      db: t.worker.db,
      provider: (userId) => history(userId),
      workerId: 'w1',
      logger: quiet,
    });
    expect(outcome).toBe('completed');
    const done = await as(userA, (tx) => getBacktest(tx, run.id));
    expect(done.status).toBe('completed');
    expect(JSON.stringify(done)).toMatch(/custom-[0-9a-f]{16}/);
  });

  it('removes cleanly: its routes go back to Alpaca and its cache goes with it', async () => {
    await as(userA, (tx) => deleteFeed(tx, { userId: userA, id: customFeedId }));
    const routes = await as(userA, (tx) => listRoutes(tx));
    const real = routes.filter((r) => r.venue === null);
    expect(real).toHaveLength(4);
    expect(real.every((r) => r.primary.name === 'Alpaca prices' && r.fallback === null)).toBe(true);
    const series = await history(userA).getBars(barsRequest());
    expect(series.dataVersion).toMatch(/^alpaca-iex-/);
    expect(series.bars).toHaveLength(21);
    const left = await t.ownerSql`select count(*)::int as n from custom_feed_cache`;
    expect(left[0]!.n).toBe(0);
    const usage = await t.ownerSql`select count(*)::int as n from custom_feed_usage`;
    expect(usage[0]!.n).toBe(0);
  });
});

/** Long ZTSTX while its close is above its 10-day average. */
function trend(): StrategyDefinition {
  const def = createDefinition();
  const px = {
    instrumentId: etf,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  const sma = { kind: 'indicator' as const, name: 'SMA', params: { period: 10 }, ...px };
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'in',
      operator: 'crosses_above',
      left: { kind: 'market', id: 'p1', ...px },
      right: { ...sma, id: 's1' },
    },
  ];
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'out',
      operator: 'crosses_below',
      left: { kind: 'market', id: 'p2', ...px },
      right: { ...sma, id: 's2' },
    },
  ];
  const leg = {
    instrumentId: etf,
    accountId: account,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    extendedHours: false,
    timing: { mode: 'immediate' as const },
    timingOnly: false,
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell', side: 'close', ...leg }];
  return def;
}
