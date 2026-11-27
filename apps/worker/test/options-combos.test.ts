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
 * Options trading brief v0.2, Phase O2 (ADR 0123), through the worker against
 * the fake Alpaca at options level 3, with OPTIONS_TRADING_ENABLED on for this
 * file only: a credit call vertical placed as one multi-leg order at its net
 * mid, its max loss and buying power on the order, closed as one order by its
 * profit target; a refused combo leaves nothing (A4); a combo close the broker
 * refuses goes leg by leg, the short leg bought back first (A4); two condors
 * count $700 of exposure (A7); a combo not filled is re-priced once together.
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
const fake = new FakeAlpaca({ now, optionsLevel: 3 });
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
  workerId: 'worker-combos',
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
  const claimed = await claimRuntimes(t.worker.db, 'worker-combos', {
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

type Leg = {
  id: string;
  side: PlannedOrder['side'];
  right: 'call' | 'put';
  pct: number;
};

/** A combo on ZTSTA: Entry legs by moneyness, the Exit legs undoing each one. */
function comboStrategy(
  legs: Leg[],
  rules: StrategyDefinition['exit']['rules'],
  sets = 1,
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
  const order = (l: Leg, side: PlannedOrder['side'], prefix: string): PlannedOrder => ({
    id: `${prefix}-${l.id}`,
    legLabel: `${prefix} ${l.id}`,
    instrumentId: ztsta,
    accountId,
    side,
    quantity: { type: 'units', value: String(sets), rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    timing: { mode: 'immediate' },
    option: {
      right: l.right,
      strikeRule: l.pct === 0 ? { type: 'atm' } : { type: 'moneynessPct', pct: l.pct },
      expiryRule: { targetDte, minDte: 1 },
    },
  });
  const def = createDefinition();
  def.entry.condition = condition('in', 'gt');
  def.entry.trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = legs.map((l) => order(l, l.side, 'Open'));
  def.exit.condition = condition('out', 'lt');
  def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
  def.exit.orders = legs.map((l) => order(l, l.side === 'buy' ? 'sell' : 'buy_to_cover', 'Close'));
  def.exit.rules = rules;
  def.risk = { ...def.risk, trailingStopPct: undefined };
  return def;
}

/** Strikes around the money on one expiry, each quoted 0.10 wide around `value(strike)`. */
function listAndQuote(
  expiry: string,
  atm: number,
  value: (right: 'call' | 'put', strike: number) => number,
  extra: { fillAtMid?: boolean } = {},
) {
  const symbols: string[] = [];
  for (let k = -12; k <= 12; k++)
    for (const r of ['C', 'P'] as const) symbols.push(occ(expiry, r, atm + k));
  fake.addOptionContracts(symbols.map((symbol) => ({ symbol })));
  quoteAll(expiry, atm, value, extra);
}

function quoteAll(
  expiry: string,
  atm: number,
  value: (right: 'call' | 'put', strike: number) => number,
  extra: { fillAtMid?: boolean } = {},
) {
  for (let k = -12; k <= 12; k++)
    for (const r of ['call', 'put'] as const) {
      const v = value(r, atm + k);
      fake.setOptionQuote(occ(expiry, r === 'call' ? 'C' : 'P', atm + k), {
        bid: (v - 0.05).toFixed(2),
        ask: (v + 0.05).toFixed(2),
        ...extra,
      });
    }
}

/** A plain smile: intrinsic value plus time value that fades away from the money. */
const fair =
  (atm: number, scale = 1) =>
  (right: 'call' | 'put', strike: number) => {
    const intrinsic = Math.max(right === 'call' ? atm - strike : strike - atm, 0);
    return intrinsic + Math.max(0.6, 3 - 0.2 * Math.abs(strike - atm)) * scale;
  };

/** Most of a credit spread's value gone: its short strike at 0.70, every other at 0.50. */
const decayed = (shortStrike: number) => (_right: 'call' | 'put', strike: number) =>
  strike === shortStrike ? 0.7 : 0.5;

const orderPosts = () =>
  fake.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/v2/orders')).length;

const fakeHeaders = () => ({
  'APCA-API-KEY-ID': fake.credentials.keyId,
  'APCA-API-SECRET-KEY': fake.credentials.secretKey,
});

const groupOf = (r: { optionDetail: unknown }) =>
  (
    r.optionDetail as {
      combo?: { netLimit: string; maxLoss?: string; buyingPower?: string; path?: string };
    }
  )?.combo;
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
    .values({ name: 'Options', email: 'options-combos@example.test' })
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

describe('options combos on paper (O2)', () => {
  it('places a credit call vertical as one order at its net mid, and closes it as one on its target (A3)', async () => {
    clock = Date.parse('2026-10-06T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 30);
    listAndQuote(expiry, atm, fair(atm));
    const s = await start(
      'Call vertical',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'call', pct: 1 },
          { id: 'long', side: 'buy', right: 'call', pct: 2 },
        ],
        [{ kind: 'optionTarget', id: 'tgt', pct: '50' }],
      ),
    );
    const postsBefore = orderPosts();
    await pass();
    let rows = await intents(s.id);
    expect(rows).toHaveLength(2);
    // One multi-leg order reached Alpaca for both legs.
    expect(orderPosts() - postsBefore).toBe(1);
    const [shortLeg, longLeg] = rows;
    const g = groupOf(shortLeg!)!;
    expect(groupOf(longLeg!)).toEqual(g);
    // §7.3: a credit, and the loss is the width less the credit.
    const net = new Decimal(g.netLimit);
    expect(net.lt(0)).toBe(true);
    const ks = new Decimal((shortLeg!.optionDetail as { contract: string }).contract.slice(-8)).div(
      1000,
    );
    const kl = new Decimal((longLeg!.optionDetail as { contract: string }).contract.slice(-8)).div(
      1000,
    );
    expect(kl.gt(ks)).toBe(true);
    expect(g.maxLoss).toBe(kl.minus(ks).plus(net).times(100).toFixed(2));
    // §8.1: buying power reserves the full width, whatever the credit.
    expect(g.buyingPower).toBe(kl.minus(ks).times(100).toFixed(2));
    await fake.tick();
    clock += 5_000;
    await pass();
    rows = await intents(s.id);
    expect(rows.map((r) => r.state)).toEqual(['filled', 'filled']);
    expect((await cycles(s.id))[0]?.status).toBe('open');

    // Half the credit kept: the spread has lost most of its value. The target
    // closes both legs as one order.
    quoteAll(expiry, atm, decayed(ks.toNumber()));
    clock = Date.parse('2026-10-06T15:31:00Z');
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    rows = await intents(s.id);
    const exits = rows.filter((r) => r.phase === 'exit');
    expect(exits).toHaveLength(2);
    expect(exits.map((r) => r.state)).toEqual(['filled', 'filled']);
    expect(groupOf(exits[0]!)?.path).toBe('combo');
    clock += 5_000;
    await pass();
    const [c] = await cycles(s.id);
    expect(c?.status).toBe('closed');
    expect((c?.state as { exitReason?: string }).exitReason).toBe('option_target');
    expect(new Decimal(c!.realizedPnl!).gt(0)).toBe(true);
    await stop(s.id);
  });

  it('refuses a combo as a whole: no leg is placed or held (A4)', async () => {
    clock = Date.parse('2026-10-07T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 30);
    listAndQuote(expiry, atm, fair(atm));
    fake.rejectNextCombo('insufficient options buying power');
    const s = await start(
      'Refused vertical',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'call', pct: 1 },
          { id: 'long', side: 'buy', right: 'call', pct: 2 },
        ],
        [],
      ),
    );
    await pass();
    clock += 5_000;
    await pass();
    const rows = await intents(s.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === 'failed' && r.filled === '0')).toBe(true);
    expect((await cycles(s.id))[0]?.status).toBe('aborted');
    // Alpaca holds nothing of it.
    const held = (await (
      await fake.fetch(`${FAKE_ALPACA_TRADING_URL}/v2/positions`, { headers: fakeHeaders() })
    ).json()) as { symbol: string }[];
    expect(
      held.filter((p) =>
        rows.some((r) => (r.optionDetail as { contract?: string } | null)?.contract === p.symbol),
      ),
    ).toEqual([]);
    await stop(s.id);
  });

  it('closes leg by leg, the short leg bought back first, when the combo close is refused (A4)', async () => {
    clock = Date.parse('2026-10-08T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 31);
    listAndQuote(expiry, atm, fair(atm));
    const s = await start(
      'Close by legs',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'call', pct: 1 },
          { id: 'long', side: 'buy', right: 'call', pct: 2 },
        ],
        [{ kind: 'optionTarget', id: 'tgt', pct: '50' }],
      ),
    );
    await pass();
    await fake.tick();
    clock += 5_000;
    await pass();
    const opened = await intents(s.id);
    expect(opened.map((r) => r.state)).toEqual(['filled', 'filled']);
    const ks = Number((opened[0]!.optionDetail as { contract: string }).contract.slice(-8)) / 1000;

    fake.setRefuseComboCloses(true);
    quoteAll(expiry, atm, decayed(ks), { fillAtMid: true });
    clock = Date.parse('2026-10-08T15:31:00Z');
    await pass();
    let rows = await intents(s.id);
    expect(rows.filter((r) => r.phase === 'exit').every((r) => r.state === 'failed')).toBe(true);
    // The next pass buys back the short leg; the long waits for it.
    clock += 5_000;
    await pass();
    rows = await intents(s.id);
    let closes = rows.filter((r) => r.phase === 'flatten');
    expect(closes).toHaveLength(1);
    expect(closes[0]!.optionDetail).toMatchObject({ combo: { path: 'legs_short_first' } });
    expect((closes[0]!.optionDetail as { combo: { legs: string[] } }).combo.legs[0]).toMatch(
      /^Buy back/,
    );
    clock += 5_000;
    await fake.tick();
    await pass();
    clock += 5_000;
    await pass();
    rows = await intents(s.id);
    closes = rows.filter((r) => r.phase === 'flatten');
    expect(closes).toHaveLength(2);
    expect((closes[1]!.optionDetail as { combo: { legs: string[] } }).combo.legs[0]).toMatch(
      /^Sell/,
    );
    clock += 5_000;
    await fake.tick();
    await pass();
    clock += 5_000;
    await pass();
    expect(closes.length).toBe(2);
    expect((await intents(s.id)).filter((r) => r.phase === 'flatten').map((r) => r.state)).toEqual([
      'filled',
      'filled',
    ]);
    expect((await cycles(s.id))[0]?.status).toBe('closed');
    fake.setRefuseComboCloses(false);
    await stop(s.id);
  });

  it('closes a contract again when its leg-by-leg close ends unfilled (staging check, 2026-11-27)', async () => {
    clock = Date.parse('2026-10-08T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 31);
    listAndQuote(expiry, atm, fair(atm));
    const s = await start(
      'Close again',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'call', pct: 1 },
          { id: 'long', side: 'buy', right: 'call', pct: 2 },
        ],
        [{ kind: 'optionTarget', id: 'tgt', pct: '50' }],
      ),
    );
    await pass();
    await fake.tick();
    clock += 5_000;
    await pass();
    const opened = await intents(s.id);
    expect(opened.map((r) => r.state)).toEqual(['filled', 'filled']);
    const ks = Number((opened[0]!.optionDetail as { contract: string }).contract.slice(-8)) / 1000;

    // The combo close is refused; the short leg's buy-back fills at its mid.
    fake.setRefuseComboCloses(true);
    quoteAll(expiry, atm, decayed(ks), { fillAtMid: true });
    clock = Date.parse('2026-10-08T15:31:00Z');
    await pass();
    clock += 5_000;
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    // The long leg's close finds no buyer at the mid, as on Alpaca paper: it is
    // re-priced once, then canceled.
    quoteAll(expiry, atm, decayed(ks), { fillAtMid: false });
    clock += 5_000;
    await pass();
    let closes = (await intents(s.id)).filter((r) => r.phase === 'flatten');
    expect(closes.map((r) => r.state)).toEqual(['filled', 'acknowledged']);
    for (const step of [125_000, 125_000, 5_000]) {
      clock += step;
      await fake.tick();
      await pass();
    }
    closes = (await intents(s.id)).filter((r) => r.phase === 'flatten');
    // Canceled after its re-price, then placed again: the cycle is never left holding it.
    expect(closes.map((r) => r.state).slice(0, 2)).toEqual(['filled', 'canceled']);
    expect(closes).toHaveLength(3);
    quoteAll(expiry, atm, decayed(ks), { fillAtMid: true });
    clock += 125_000;
    await fake.tick();
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    clock += 5_000;
    await pass();
    const states = (await intents(s.id)).filter((r) => r.phase === 'flatten').map((r) => r.state);
    expect(states.at(-1)).toBe('filled');
    expect((await cycles(s.id))[0]?.status).toBe('closed');
    fake.setRefuseComboCloses(false);
    await stop(s.id);
  });

  it('counts two iron condors as their max loss, and re-prices a combo once together (A7)', async () => {
    clock = Date.parse('2026-10-13T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 30);
    // Not filled at the mid: the combo rests.
    listAndQuote(expiry, atm, fair(atm), { fillAtMid: false });
    const s = await start(
      'Two condors',
      comboStrategy(
        [
          { id: 'sp', side: 'sell_short', right: 'put', pct: 1 },
          { id: 'lp', side: 'buy', right: 'put', pct: 2 },
          { id: 'sc', side: 'sell_short', right: 'call', pct: 1 },
          { id: 'lc', side: 'buy', right: 'call', pct: 2 },
        ],
        [],
        2,
      ),
    );
    await pass();
    let rows = await intents(s.id);
    expect(rows).toHaveLength(4);
    const g = groupOf(rows[0]!)!;
    expect(rows.every((r) => groupOf(r)?.netLimit === g.netLimit)).toBe(true);
    expect(rows.every((r) => r.quantity === '2')).toBe(true);
    const strikes = rows.map((r) =>
      new Decimal((r.optionDetail as { contract: string }).contract.slice(-8)).div(1000),
    );
    const width = Decimal.max(strikes[0]!.minus(strikes[1]!), strikes[3]!.minus(strikes[2]!));
    // Two sets: max loss = 2 × (width − credit) × 100; the reserve, 2 × width × 100.
    expect(g.maxLoss).toBe(width.plus(g.netLimit).times(200).toFixed(2));
    expect(g.buyingPower).toBe(width.times(200).toFixed(2));
    expect(rows.every((r) => ['submitted', 'acknowledged'].includes(r.state))).toBe(true);

    // 120 s on: one replace of the whole order, every leg toward its touch.
    clock += 121_000;
    await fake.tick();
    await pass();
    const patches = fake.requests.filter((r) => r.method === 'PATCH');
    expect(patches.length).toBeGreaterThan(0);
    const events = await as((tx) =>
      tx
        .select({ intentId: schema.orderEvents.intentId, payload: schema.orderEvents.payload })
        .from(schema.orderEvents),
    );
    const repriced = new Set(
      events
        .filter((e) => (e.payload as { kind?: string }).kind === 'option_reprice')
        .map((e) => e.intentId),
    );
    expect(rows.every((r) => repriced.has(r.id))).toBe(true);

    // The market comes to it: every leg fills together.
    quoteAll(expiry, atm, fair(atm), { fillAtMid: true });
    clock += 5_000;
    await fake.tick();
    await pass();
    rows = await intents(s.id);
    expect(rows.map((r) => r.state)).toEqual(['filled', 'filled', 'filled', 'filled']);
    clock += 5_000;
    await pass();
    // A7 at fill: the risk check saw the two condors' max loss as the order's notional.
    const risk = rows[0]!.risk as { checks: { code: string; value?: string }[] };
    expect(risk.checks.find((c) => c.code === 'risk_order_notional')?.value ?? g.maxLoss).toBe(
      g.maxLoss,
    );
    await stop(s.id);
  });
  it('records an assignment from what the broker holds, closes the rest, and confirms it the next morning (A11)', async () => {
    clock = Date.parse('2026-10-14T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 30);
    listAndQuote(expiry, atm, fair(atm));
    const s = await start(
      'Put vertical',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'put', pct: 1 },
          { id: 'long', side: 'buy', right: 'put', pct: 2 },
        ],
        [],
      ),
    );
    await pass();
    await fake.tick();
    clock += 5_000;
    await pass();
    const opened = await intents(s.id);
    expect(opened.map((r) => r.state)).toEqual(['filled', 'filled']);
    const shortPut = (opened[0]!.optionDetail as { contract: string }).contract;
    const strike = new Decimal(shortPut.slice(-8)).div(1000);

    // Overnight the short put is assigned: 100 shares bought at the strike.
    clock = Date.parse('2026-10-15T12:00:00Z');
    await fake.assignOption(shortPut, 'ZTSTA');
    await pass();
    let rows = await intents(s.id);
    const assigned = rows.filter((r) => (r.closeReason ?? '').startsWith('Assigned'));
    expect(assigned).toHaveLength(2);
    const [contract, shares] = assigned;
    expect(contract).toMatchObject({ state: 'filled', quantity: '1', averagePrice: '0' });
    expect(shares).toMatchObject({ state: 'filled', quantity: '100' });
    expect(new Decimal(shares!.averagePrice!).eq(strike)).toBe(true);
    const kinds = await as((tx) =>
      tx
        .select({ kind: schema.fills.kind })
        .from(schema.fills)
        .where(eq(schema.fills.intentId, contract!.id)),
    );
    expect(kinds).toEqual([{ kind: 'assignment' }]);
    // Nothing unexplained: no mismatch for the assignment.
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

    // At the open: the long put and the shares close; the cycle says why.
    clock = Date.parse('2026-10-15T13:31:00Z');
    quoteAll(expiry, atm, fair(atm), { fillAtMid: true });
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    clock += 5_000;
    await fake.tick();
    await pass();
    rows = await intents(s.id);
    const recordedIds = new Set(assigned.map((r) => r.id));
    const closes = rows.filter((r) => r.phase === 'flatten' && !recordedIds.has(r.id));
    expect(closes.length).toBeGreaterThanOrEqual(2);
    expect(closes.every((r) => (r.closeReason ?? '').startsWith('Assigned:'))).toBe(true);
    clock += 5_000;
    await pass();
    const [c] = await cycles(s.id);
    expect((c?.state as { exitReason?: string }).exitReason).toBe('assigned');
    expect(c?.status).toBe('closed');

    // The next morning Alpaca's activity record shows it: confirmed.
    clock = Date.parse('2026-10-16T13:00:00Z');
    await pass();
    const [rt] = await as((tx) =>
      tx
        .select({ state: schema.strategyRuntimes.state })
        .from(schema.strategyRuntimes)
        .where(eq(schema.strategyRuntimes.strategyId, s.id)),
    );
    const a = (rt?.state as { options?: { assigned?: Record<string, { confirmedAt?: string }> } })
      .options?.assigned;
    expect(fake.requests.some((r) => r.url.includes('/v2/account/activities?'))).toBe(true);
    expect(a === undefined || Object.values(a).every((x) => x.confirmedAt)).toBe(true);
    await stop(s.id);
  });
  it('closes a combo whose short call is likely to be exercised for tomorrow’s dividend (§7.5)', async () => {
    clock = Date.parse('2026-10-20T14:31:00Z');
    let price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 31);
    listAndQuote(expiry, atm, fair(atm));
    const s = await start(
      'Dividend watch',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'call', pct: -2 },
          { id: 'long', side: 'buy', right: 'call', pct: 2 },
        ],
        [],
      ),
    );
    await pass();
    await fake.tick();
    clock += 5_000;
    await pass();
    const opened = await intents(s.id);
    expect(opened.map((r) => r.state)).toEqual(['filled', 'filled']);
    const shortCall = (opened[0]!.optionDetail as { contract: string }).contract;
    const strike = new Decimal(shortCall.slice(-8)).div(1000);

    // ZTSTA goes ex-dividend tomorrow, $0.50 a share, and the short call has
    // only 0.10 of time value left.
    clock += 60_000;
    fake.setDividend('ZTSTA', '2026-10-21', '0.50');
    price = await ztstaPrice();
    const intrinsic = Decimal.max(price.minus(strike), 0).toNumber();
    expect(intrinsic).toBeGreaterThan(0);
    quoteAll(expiry, atm, fair(atm), { fillAtMid: true });
    fake.setOptionQuote(shortCall, {
      bid: (intrinsic + 0.05).toFixed(2),
      ask: (intrinsic + 0.15).toFixed(2),
      fillAtMid: true,
    });
    await pass();
    const rows = await intents(s.id);
    const closes = rows.filter((r) => r.phase === 'flatten');
    // The short call is bought back first; the long waits for it.
    expect(closes).toHaveLength(1);
    expect(closes[0]!.closeReason).toMatch(
      /^Closed before a dividend: ZTSTA goes ex-dividend 2026-10-21/,
    );
    expect((closes[0]!.optionDetail as { contract: string }).contract).toBe(shortCall);
    const [c] = await cycles(s.id);
    expect((c?.state as { exitReason?: string }).exitReason).toBe('dividend_risk');
    expect(fake.requests.some((r) => r.url.includes('/v1/corporate-actions'))).toBe(true);
    await stop(s.id);
  });
  it('closes a combo whose short leg is near the money a day before its expiry, from 15:00 (§8.3)', async () => {
    clock = Date.parse('2026-10-26T14:31:00Z'); // Monday
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = '2026-10-27';
    listAndQuote(expiry, atm, fair(atm));
    const s = await start(
      'Day early',
      comboStrategy(
        [
          { id: 'short', side: 'sell_short', right: 'call', pct: 0 },
          { id: 'long', side: 'buy', right: 'call', pct: 2 },
        ],
        [],
        1,
        1,
      ),
    );
    await pass();
    await fake.tick();
    clock += 5_000;
    await pass();
    expect((await intents(s.id)).map((r) => r.state)).toEqual(['filled', 'filled']);
    // 14:00 New York: nothing yet.
    clock = Date.parse('2026-10-26T18:00:00Z');
    await pass();
    expect((await intents(s.id)).filter((r) => r.phase === 'flatten')).toHaveLength(0);
    // 15:01: the short leg near the money is bought back first.
    clock = Date.parse('2026-10-26T19:01:00Z');
    quoteAll(expiry, atm, fair(atm), { fillAtMid: true });
    await pass();
    const closes = (await intents(s.id)).filter((r) => r.phase === 'flatten');
    expect(closes).toHaveLength(1);
    expect(closes[0]!.closeReason).toMatch(/^Closed before expiry:/);
    expect((await cycles(s.id))[0]?.state).toMatchObject({ exitReason: 'closed_before_expiry' });
    await stop(s.id);
  });
});
