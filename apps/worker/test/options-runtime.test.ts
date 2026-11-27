import { AlpacaRequestBudget } from '@tm/alpaca';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  and,
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
  stopStrategy,
  updateStrategy,
  validateStoredStrategy,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  addDays,
  createDefinition,
  nyDate,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaBrokerProvider, alpacaProvider } from '../src/alpaca';
import { runBrokerChecks } from '../src/broker-checks';
import type { BrokerRegistry } from '../src/brokers';
import { createOptionsLifecycle } from '../src/options-trading/lifecycle';
import { demoProvider, type ProviderRegistry } from '../src/providers';
import { runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';
import { valueAccount } from '../src/valuations';

/**
 * Options trading brief v0.2, Phase O1 (ADR 0123), through the worker against
 * the fake Alpaca, with OPTIONS_TRADING_ENABLED on for this file only: a long
 * call resolved from the contract list, sent as a limit at the mid, re-priced
 * once at 120 s, closed by its profit target; an expiry-day close from 15:00
 * moving to the touch at 15:20 (A6); a worthless expiry settled at 0 with the
 * premium as the loss (A6).
 */

let t: TestDatabase;
let userId: string;
let ztsta: string;
let accountId: string;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
/** Tuesday 2026-10-06, 10:31 New York time. */
let clock = Date.parse('2026-10-06T14:31:00Z');
const now = () => new Date(clock);
const fake = new FakeAlpaca({ now, optionsLevel: 2 });
const fakeUrls = {
  fetch: fake.fetch,
  // The options share of the key's budget runs on the test's clock, not the wall's.
  budget: new AlpacaRequestBudget({ now: () => clock }),
  fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
};
const providers: ProviderRegistry = { alpaca: alpacaProvider(fakeUrls) };
const brokers: BrokerRegistry = { alpaca: alpacaBrokerProvider(fakeUrls) };
const demo = createDemoLiveFeed({ now });

const as = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);

const runtimeOptions = (): RuntimeWorkerOptions => ({
  db: t.worker.db,
  workerId: 'worker-options',
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
  optionsLifecycle: createOptionsLifecycle({ logger: quiet }),
});

async function pass() {
  const claimed = await claimRuntimes(t.worker.db, 'worker-options', {
    leaseSeconds: 30,
    limit: 10,
  });
  for (const c of claimed) await runRuntimePass(runtimeOptions(), c.runtimeId, c.userId);
}

/** ZTSTA's price now, from the same demo path the fake trades on. */
async function ztstaPrice(): Promise<Decimal> {
  const q = await demo.latestQuote({ instrumentId: 'x', symbol: 'DEMO-A' });
  return q!.last;
}

/** OCC symbol for a ZTSTA contract. */
const occ = (expiry: string, right: 'C' | 'P', strike: number) =>
  `ZTSTA${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${right}${String(
    Math.round(strike * 1000),
  ).padStart(8, '0')}`;

const intents = (strategyId: string) =>
  as((tx) =>
    tx
      .select({
        id: schema.orderIntents.id,
        phase: schema.orderIntents.phase,
        orderType: schema.orderIntents.orderType,
        limitPrice: schema.orderIntents.limitPrice,
        quantity: schema.orderIntents.quantity,
        instrumentId: schema.orderIntents.instrumentId,
        optionDetail: schema.orderIntents.optionDetail,
        closeReason: schema.orderIntents.closeReason,
        state: schema.brokerOrders.state,
        filled: schema.brokerOrders.filledQuantity,
        averagePrice: schema.brokerOrders.averagePrice,
        risk: schema.orderIntents.risk,
      })
      .from(schema.orderIntents)
      .innerJoin(schema.brokerOrders, eq(schema.brokerOrders.intentId, schema.orderIntents.id))
      .where(eq(schema.orderIntents.strategyId, strategyId))
      .orderBy(schema.orderIntents.createdAt),
  );

const cycles = (strategyId: string) =>
  as((tx) =>
    tx
      .select({
        status: schema.strategyCycles.status,
        state: schema.strategyCycles.state,
        realizedPnl: schema.strategyCycles.realizedPnl,
      })
      .from(schema.strategyCycles)
      .innerJoin(
        schema.strategyRuntimes,
        eq(schema.strategyRuntimes.id, schema.strategyCycles.runtimeId),
      )
      .where(eq(schema.strategyRuntimes.strategyId, strategyId))
      .orderBy(schema.strategyCycles.seq),
  );

function longCallStrategy(
  name: string,
  strike: { type: 'atm' } | { type: 'moneynessPct'; pct: number },
  rules: StrategyDefinition['exit']['rules'],
  targetDte = 30,
): StrategyDefinition {
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
    accountId,
    side,
    quantity: { type: 'units', value: '1', rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    timing: { mode: 'immediate' },
    option: {
      right: 'call',
      strikeRule: strike,
      expiryRule: { targetDte, minDte: 1 },
    },
  });
  const def = createDefinition();
  def.entry.condition = condition('in', 'gt');
  def.entry.trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = [leg('Buy call', 'buy')];
  def.exit.condition = condition('out', 'lt');
  def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
  def.exit.orders = [leg('Sell call', 'sell')];
  def.exit.rules = rules;
  def.risk = { ...def.risk, trailingStopPct: undefined };
  return def;
}

async function stop(id: string) {
  await as(async (tx) => {
    const [row] = await tx
      .select({ rowVersion: schema.strategies.rowVersion })
      .from(schema.strategies)
      .where(eq(schema.strategies.id, id));
    await stopStrategy(tx, userId, id, { rowVersion: row!.rowVersion });
  });
}

async function start(name: string, def: StrategyDefinition) {
  return as(async (tx) => {
    let s = await createStrategy(tx, userId, { name, definition: def });
    s = await updateStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      status: 'under_testing',
    });
    const { validation } = await validateStoredStrategy(tx, s.id);
    expect(validation.errors).toEqual([]);
    await startStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      confirmed: true,
      acknowledgedWarnings: validation.warnings.map((w) => w.code),
    });
    return s;
  });
}

beforeAll(async () => {
  process.env.OPTIONS_TRADING_ENABLED = 'true';
  t = await createTestDatabase();
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Options', email: 'options-runtime@example.test' })
    .returning({ id: schema.users.id });
  userId = row!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Options' });
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
  const credential = await as((tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Alpaca paper',
      fields: fake.credentials,
      publicKey: keys.publicKey,
    }),
  );
  const platform = await as((tx) =>
    createPlatform(tx, { userId, name: 'Alpaca', provider: 'alpaca', credentialId: credential.id }),
  );
  await runBrokerChecks({
    db: t.worker.db,
    brokers,
    privateKey: keys.privateKey,
    logger: quiet,
    now: () => new Date(),
  });
  accountId = (await as(listPlatforms)).find((p) => p.id === platform.id)!.accounts[0]!.id;
  await as((tx) =>
    createFeed(tx, {
      userId,
      name: 'Alpaca prices',
      provider: 'alpaca',
      credentialId: credential.id,
      assetClasses: ['stock', 'etf'],
    }),
  );
  // The valuation reads the account and keeps the options level Alpaca reports.
  await valueAccount(
    { db: t.worker.db, providers, brokers, privateKey: keys.privateKey, logger: quiet, now },
    accountId,
    userId,
  );
}, 60_000);

afterAll(async () => {
  delete process.env.OPTIONS_TRADING_ENABLED;
  await t?.drop();
});

describe('a long call on paper (O1)', () => {
  it('records the options level the account reports', async () => {
    const [a] = await as((tx) =>
      tx
        .select({ level: schema.tradingAccounts.brokerOptionsLevel })
        .from(schema.tradingAccounts)
        .where(eq(schema.tradingAccounts.id, accountId)),
    );
    expect(a?.level).toBe(2);
  });

  it('resolves, prices at the mid, re-prices once, fills and exits on its profit target', async () => {
    const price = await ztstaPrice();
    const today = nyDate(now());
    const atm = Math.round(price.toNumber());
    // Expiries 6, 13, 30 and 44 days out; strikes around the money (A2's shape).
    const expiries = [6, 13, 30, 44].map((d) => addDays(today, d));
    const contracts = expiries.flatMap((e) =>
      [-2, -1, 0, 1, 2].flatMap((k) => [
        { symbol: occ(e, 'C', atm + k) },
        { symbol: occ(e, 'P', atm + k) },
      ]),
    );
    fake.addOptionContracts(contracts);
    const chosen = occ(expiries[2]!, 'C', atm);
    fake.setOptionQuote(chosen, { bid: '2.00', ask: '2.20' });

    const s = await start(
      'Long call',
      longCallStrategy('Long call', { type: 'atm' }, [
        { kind: 'optionTarget', id: 'tgt', pct: '50' },
      ]),
    );
    await pass();
    let rows = await intents(s.id);
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry).toMatchObject({
      phase: 'entry',
      orderType: 'limit',
      limitPrice: '2.1',
      quantity: '1',
    });
    expect(['submitted', 'acknowledged']).toContain(entry.state);
    expect(entry.optionDetail).toMatchObject({
      underlying: 'ZTSTA',
      contract: chosen,
      quote: { bid: '2', ask: '2.2' },
    });
    expect((entry.optionDetail as { words: string }).words).toMatch(/^ZTSTA \d+ call, expiring /);
    // The contract became a Core instrument, priced at 100 shares a contract.
    const [inst] = await as((tx) =>
      tx.select().from(schema.instruments).where(eq(schema.instruments.symbol, chosen)),
    );
    expect(inst).toMatchObject({ assetClass: 'option', multiplier: '100' });
    expect(fake.requests.some((r) => r.url.includes('/v2/options/contracts'))).toBe(true);
    expect(fake.requests.some((r) => r.url.includes('/v1beta1/options/quotes/latest'))).toBe(true);

    // Not filled at the mid after 120 s: re-priced once, a third of the way to the ask.
    clock += 121_000;
    await fake.tick();
    await pass();
    expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(true);
    const events = await as((tx) =>
      tx
        .select({ payload: schema.orderEvents.payload })
        .from(schema.orderEvents)
        .where(eq(schema.orderEvents.intentId, entry.id)),
    );
    const reprice = events.find((e) => (e.payload as { kind?: string }).kind === 'option_reprice');
    expect(reprice?.payload).toMatchObject({ limitPrice: '2.14' });
    rows = await intents(s.id);
    expect(rows).toHaveLength(1);
    expect(['submitted', 'acknowledged']).toContain(rows[0]!.state);

    // The market comes to it: the re-priced order fills, and only that one.
    fake.setOptionQuote(chosen, { bid: '2.10', ask: '2.10', fillAtMid: true });
    clock += 5_000;
    await fake.tick();
    await pass();
    rows = await intents(s.id);
    expect(rows[0]).toMatchObject({ state: 'filled', filled: '1', averagePrice: '2.1' });
    expect((await cycles(s.id))[0]?.status).toBe('open');

    // 50% on the premium: the profit target closes it at the mid, checked as
    // Check Exit is (here on the next completed hourly bar, 11:30).
    fake.setOptionQuote(chosen, { bid: '3.20', ask: '3.40', fillAtMid: true });
    clock = Date.parse('2026-10-06T15:31:00Z');
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    rows = await intents(s.id);
    const exit = rows.find((r) => r.phase === 'exit');
    expect(exit).toMatchObject({ orderType: 'limit', limitPrice: '3.3', state: 'filled' });
    clock += 5_000;
    await pass();
    const [c] = await cycles(s.id);
    expect(c?.status).toBe('closed');
    expect((c?.state as { exitReason?: string }).exitReason).toBe('option_target');
    // (3.30 − 2.10) × 100 = $120.
    expect(new Decimal(c!.realizedPnl!).toFixed(2)).toBe('120.00');
    await stop(s.id);
  });

  it('closes on expiry day from 15:00 at the mid, then at the bid from 15:20 (A6)', async () => {
    clock = Date.parse('2026-10-07T14:31:00Z');
    const price = await ztstaPrice();
    const today = nyDate(now());
    const expiry = addDays(today, 2); // Friday 2026-10-09
    const atm = Math.round(price.toNumber());
    const chosen = occ(expiry, 'C', atm);
    fake.addOptionContracts([{ symbol: chosen }, { symbol: occ(expiry, 'C', atm + 1) }]);
    fake.setOptionQuote(chosen, { bid: '1.00', ask: '1.00', fillAtMid: true });
    const s = await start('Expiry close', longCallStrategy('Expiry close', { type: 'atm' }, [], 2));
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    expect((await intents(s.id))[0]).toMatchObject({ state: 'filled', limitPrice: '1' });

    // Expiry day, 15:01 New York time: a close at the mid, not filled.
    clock = Date.parse(`${expiry}T19:01:00Z`);
    fake.setOptionQuote(chosen, { bid: '0.40', ask: '0.60' });
    await pass();
    let close = (await intents(s.id)).find((r) => r.phase === 'flatten');
    expect(close).toMatchObject({ orderType: 'limit', limitPrice: '0.5' });
    expect(['submitted', 'acknowledged']).toContain(close!.state);
    expect(close!.optionDetail).toMatchObject({ lifecycle: 'Closed before expiry' });
    expect(close!.closeReason).toMatch(/^Closed before expiry:/);

    // 15:21: moved to the bid once; never canceled for its timeout.
    clock = Date.parse(`${expiry}T19:21:00Z`);
    await fake.tick();
    await pass();
    fake.setOptionQuote(chosen, { bid: '0.40', ask: '0.40', fillAtMid: true });
    clock += 5_000;
    await fake.tick();
    await pass();
    close = (await intents(s.id)).find((r) => r.phase === 'flatten');
    expect(close).toMatchObject({ state: 'filled', averagePrice: '0.4' });
    clock += 5_000;
    await pass();
    const [c] = await cycles(s.id);
    expect(c?.status).toBe('closed');
    expect((c?.state as { exitReason?: string }).exitReason).toBe('closed_before_expiry');
    // (0.40 − 1.00) × 100 = −$60.
    expect(new Decimal(c!.realizedPnl!).toFixed(2)).toBe('-60.00');
    await stop(s.id);
  });

  it('settles a contract that expired worthless at 0, the premium as the loss (A6)', async () => {
    clock = Date.parse('2026-10-12T14:31:00Z');
    const price = await ztstaPrice();
    const today = nyDate(now());
    const expiry = addDays(today, 4); // Friday 2026-10-16
    // Far out of the money: 25% above the price.
    const strike = Math.round(price.toNumber() * 1.25);
    const chosen = occ(expiry, 'C', strike);
    fake.addOptionContracts([{ symbol: chosen }]);
    fake.setOptionQuote(chosen, { bid: '2.00', ask: '2.00', fillAtMid: true });
    const s = await start(
      'Worthless',
      longCallStrategy('Worthless', { type: 'moneynessPct', pct: 25 }, [], 4),
    );
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    const [entry] = await intents(s.id);
    expect(entry).toMatchObject({ state: 'filled', averagePrice: '2' });

    // Expiry day after 15:00 with no quote: nothing can be sent, the underlying is seen.
    clock = Date.parse(`${expiry}T19:30:00Z`);
    fake.setOptionQuote(chosen, { bid: '0', ask: '0' });
    expect((await ztstaPrice()).lt(strike)).toBe(true);
    await pass();
    expect((await intents(s.id)).filter((r) => r.phase === 'flatten')).toHaveLength(0);

    // Monday: Alpaca removed it. The app settles it before reconciling.
    clock = Date.parse('2026-10-19T14:31:00Z');
    await fake.expireOption(chosen);
    await pass();
    const settled = (await intents(s.id)).find((r) => r.phase === 'flatten');
    expect(settled).toMatchObject({ state: 'filled', averagePrice: '0' });
    expect(settled!.closeReason).toMatch(/^Expired worthless:/);
    const [fill] = await as((tx) =>
      tx.select().from(schema.fills).where(eq(schema.fills.intentId, settled!.id)),
    );
    expect(fill).toMatchObject({ kind: 'expiry', price: '0' });
    clock += 5_000;
    await pass();
    const [c] = await cycles(s.id);
    expect(c?.status).toBe('closed');
    expect((c?.state as { exitReason?: string }).exitReason).toBe('expired_worthless');
    expect(new Decimal(c!.realizedPnl!).toFixed(2)).toBe('-200.00');
    // Nothing unexplained: no mismatch was opened for the expiry.
    const incidents = await as((tx) =>
      tx
        .select()
        .from(schema.executionIncidents)
        .where(
          and(
            eq(schema.executionIncidents.userId, userId),
            eq(schema.executionIncidents.kind, 'reconciliation_mismatch'),
          ),
        ),
    );
    expect(incidents).toHaveLength(0);
  });

  it('refuses a contract whose quote is 90 s old or whose spread is 45% of the mid (A8)', async () => {
    clock = Date.parse('2026-10-20T14:31:00Z');
    const price = await ztstaPrice();
    const expiry = addDays(nyDate(now()), 31);
    const atm = Math.round(price.toNumber());
    const chosen = occ(expiry, 'C', atm);
    fake.addOptionContracts([{ symbol: chosen }]);
    fake.setOptionQuote(chosen, {
      bid: '2.00',
      ask: '2.20',
      at: new Date(clock - 90_000).toISOString(),
    });
    const postsBefore = fake.requests.filter(
      (r) => r.method === 'POST' && r.url.endsWith('/v2/orders'),
    ).length;
    const s = await start('Stale quote', longCallStrategy('Stale quote', { type: 'atm' }, [], 31));
    await pass();
    let [refused] = await intents(s.id);
    expect(refused?.state).toBe('rejected');
    expect(refused?.risk).toMatchObject({ code: 'option_quote_stale' });
    await stop(s.id);

    clock += 3_600_000; // the next hourly bar, and past the 15-second quote cadence
    fake.setOptionQuote(chosen, { bid: '1.00', ask: '1.50' });
    const w = await start('Wide spread', longCallStrategy('Wide spread', { type: 'atm' }, [], 31));
    await pass();
    [refused] = await intents(w.id);
    expect(refused?.state).toBe('rejected');
    expect(refused?.risk).toMatchObject({ code: 'option_spread_wide' });
    // Nothing reached Alpaca for either.
    expect(
      fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/v2/orders')).length,
    ).toBe(postsBefore);
    await stop(w.id);
  });

  it('decided while closed, picks again from the new list and quote at the open (A13)', async () => {
    // Thursday 18:00 New York: the market is closed; Entry fires on the last bar.
    clock = Date.parse('2026-10-22T22:00:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const first = occ('2026-11-27', 'C', atm);
    fake.addOptionContracts([{ symbol: first }]);
    fake.setOptionQuote(first, { bid: '2.00', ask: '2.10' });
    const s = await start('Overnight', longCallStrategy('Overnight', { type: 'atm' }, []));
    await pass();
    expect(await intents(s.id)).toHaveLength(0);

    // Overnight a contract nearer the 30-day target is listed.
    const better = occ('2026-11-23', 'C', atm);
    fake.addOptionContracts([{ symbol: better }]);
    clock = Date.parse('2026-10-23T13:31:00Z');
    fake.setOptionQuote(better, { bid: '1.50', ask: '1.60' });
    fake.setOptionQuote(first, { bid: '2.00', ask: '2.10' });
    await pass();
    const [entry] = await intents(s.id);
    expect(entry?.optionDetail).toMatchObject({
      contract: better,
      decided: { at: '2026-10-22T22:00:00.000Z' },
    });
    expect((entry?.optionDetail as { decided: { contract: string } }).decided.contract).not.toBe(
      better,
    );
    expect(entry?.limitPrice).toBe('1.55');
    await stop(s.id);
  });
});
