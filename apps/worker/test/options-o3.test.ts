import { AlpacaRequestBudget } from '@tm/alpaca';
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
import type Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaBrokerProvider, alpacaProvider } from '../src/alpaca';
import { runBrokerChecks } from '../src/broker-checks';
import type { BrokerRegistry } from '../src/brokers';
import { createOptionsLifecycle } from '../src/options-trading/lifecycle';
import { demoProvider, type ProviderRegistry } from '../src/providers';
import { runRuntimePass, type RuntimeWorkerOptions } from '../src/runtime';
import { valueAccount } from '../src/valuations';

/**
 * Options trading brief v0.2, Phase O3 (ADR 0123), through the worker against
 * the fake Alpaca, with OPTIONS_TRADING_ENABLED on for this file only: a
 * covered call sold once its shares are held and bought back before they are
 * sold; a cash-secured put counted at its strike less the premium; the roll
 * rule closing a contract and opening a later one in the same cycle.
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
  workerId: 'worker-o3',
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
  const claimed = await claimRuntimes(t.worker.db, 'worker-o3', {
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

const fakeHeaders = () => ({
  'APCA-API-KEY-ID': fake.credentials.keyId,
  'APCA-API-SECRET-KEY': fake.credentials.secretKey,
});

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
      // The amounts below are sized for the former fixed $100,000 (N400).
      startingCapital: '100000',
    });
    return s;
  });
}

beforeAll(async () => {
  process.env.OPTIONS_TRADING_ENABLED = 'true';
  t = await createTestDatabase();
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Options', email: 'options-o3@example.test' })
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

/** An Exit or Entry leg on ZTSTA: shares, or an option by moneyness. */
function legOf(
  id: string,
  side: PlannedOrder['side'],
  quantity: string,
  option?: { right: 'call' | 'put'; pct: number; minDte?: number },
): PlannedOrder {
  return {
    id,
    legLabel: id,
    instrumentId: ztsta,
    accountId,
    side,
    quantity: { type: 'units', value: quantity, rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    timing: { mode: 'immediate' },
    ...(option
      ? {
          option: {
            right: option.right,
            strikeRule:
              option.pct === 0 ? { type: 'atm' } : { type: 'moneynessPct', pct: option.pct },
            expiryRule: { targetDte: 30, minDte: option.minDte ?? 1 },
          },
        }
      : {}),
  };
}

function withLegs(
  entry: PlannedOrder[],
  exit: PlannedOrder[],
  rules: StrategyDefinition['exit']['rules'],
): StrategyDefinition {
  const def = comboStrategy([], rules);
  def.entry.orders = entry;
  def.exit.orders = exit;
  // 100 ZTSTA shares are worth more than the default order limit.
  def.risk = { ...def.risk, maxOrderNotional: '60000', maxStrategyExposure: '90000' };
  return def;
}

const held = async () =>
  (await (
    await fake.fetch(`${FAKE_ALPACA_TRADING_URL}/v2/positions`, { headers: fakeHeaders() })
  ).json()) as { symbol: string; qty: string }[];

describe('covered calls and cash-secured puts on paper (O3)', () => {
  it('sells the call once its shares are held, and buys it back before the shares are sold', async () => {
    clock = Date.parse('2026-10-13T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 30);
    listAndQuote(expiry, atm, fair(atm), { fillAtMid: true });
    const s = await start(
      'Covered call',
      withLegs(
        [
          legOf('Buy shares', 'buy', '100'),
          legOf('Sell call', 'sell_short', '1', { right: 'call', pct: 1 }),
        ],
        [
          legOf('Sell shares', 'sell', '100'),
          legOf('Buy back call', 'buy_to_cover', '1', { right: 'call', pct: 1 }),
        ],
        [{ kind: 'optionTarget', id: 'tgt', pct: '50' }],
      ),
    );
    await pass();
    let rows = await intents(s.id);
    // Only the shares go first: the call waits for them.
    expect(rows.map((r) => r.instrumentId)).toEqual([ztsta]);
    await fake.tick();
    clock += 5_000;
    await pass();
    rows = await intents(s.id);
    expect(rows).toHaveLength(2);
    const call = rows[1]!;
    expect(call.optionDetail).toMatchObject({ sold: { kind: 'covered_call', maxLoss: '0.00' } });
    await fake.tick();
    clock += 5_000;
    await pass();
    rows = await intents(s.id);
    expect(rows.map((r) => r.state)).toEqual(['filled', 'filled']);
    expect((await cycles(s.id))[0]?.status).toBe('open');

    // The call fades: the target fires. The call is bought back first.
    const strike = Number((call.optionDetail as { contract: string }).contract.slice(-8)) / 1000;
    quoteAll(expiry, atm, decayed(strike), { fillAtMid: true });
    clock = Date.parse('2026-10-13T15:31:00Z');
    await pass();
    rows = await intents(s.id);
    let exits = rows.filter((r) => r.phase === 'exit');
    expect(exits.map((r) => r.instrumentId)).toEqual([call.instrumentId]);
    await fake.tick();
    clock += 5_000;
    await pass();
    rows = await intents(s.id);
    exits = rows.filter((r) => r.phase === 'exit');
    expect(exits.map((r) => r.instrumentId)).toEqual([call.instrumentId, ztsta]);
    await fake.tick();
    clock += 5_000;
    await pass();
    clock += 5_000;
    await pass();
    const [c] = await cycles(s.id);
    expect(c?.status).toBe('closed');
    expect(
      (await held()).filter((p) => p.symbol === 'ZTSTA' || p.symbol.startsWith('ZTSTA2')),
    ).toEqual([]);
    await stop(s.id);
  });

  it('counts a cash-secured put at its strike less the premium, and sets the strike aside', async () => {
    clock = Date.parse('2026-10-14T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    const expiry = addDays(nyDate(now()), 30);
    listAndQuote(expiry, atm, fair(atm), { fillAtMid: true });
    const def = withLegs(
      [legOf('Sell put', 'sell_short', '1', { right: 'put', pct: 2 })],
      [legOf('Buy back put', 'buy_to_cover', '1', { right: 'put', pct: 2 })],
      [],
    );
    // Too small for the put's max loss: refused, naming it.
    def.risk = { ...def.risk, maxOrderNotional: '1000' };
    const refused = await start('Cash-secured put, refused', def);
    await pass();
    let rows = await intents(refused.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('rejected');
    const check = (rows[0]!.risk as { checks: { code: string; value?: string }[] }).checks.find(
      (x) => x.code === 'risk_order_size',
    );
    const sold = rows[0]!.optionDetail as {
      contract: string;
      sold: { maxLoss: string; buyingPower: string };
    };
    const k = Number(sold.contract.slice(-8)) / 1000;
    const mid = Number(rows[0]!.limitPrice);
    expect(check?.value).toBe(((k - mid) * 100).toFixed(2));
    expect(sold.sold.buyingPower).toBe((k * 100).toFixed(2));
    await stop(refused.id);

    def.risk = { ...def.risk, maxOrderNotional: '60000' };
    const s = await start('Cash-secured put', def);
    await pass();
    rows = await intents(s.id);
    expect(rows[0]!.optionDetail).toMatchObject({ sold: { kind: 'cash_secured_put' } });
    expect(rows[0]!.state).not.toBe('failed');
    await fake.tick();
    clock += 5_000;
    await pass();
    expect((await cycles(s.id))[0]?.status).toBe('open');
    await stop(s.id);
  });
});

describe('the roll rule on paper (O3)', () => {
  it('closes a contract at its days to expiry and opens a later one in the same cycle', async () => {
    clock = Date.parse('2026-10-15T14:31:00Z');
    const price = await ztstaPrice();
    const atm = Math.round(price.toNumber());
    // 30 days out is the Entry's pick (earlier tests' expiries are listed too).
    const first = addDays(nyDate(now()), 30);
    const later = addDays(nyDate(now()), 44);
    listAndQuote(first, atm, fair(atm), { fillAtMid: true });
    listAndQuote(later, atm, fair(atm), { fillAtMid: true });
    const s = await start(
      'Rolled call',
      withLegs(
        [legOf('Buy call', 'buy', '1', { right: 'call', pct: 0, minDte: 20 })],
        [legOf('Sell call', 'sell', '1', { right: 'call', pct: 0, minDte: 20 })],
        [{ kind: 'optionRoll', id: 'roll', days: 19 }],
      ),
    );
    await pass();
    await fake.tick();
    clock += 5_000;
    await pass();
    let rows = await intents(s.id);
    expect(rows.map((r) => r.state)).toEqual(['filled']);
    const firstContract = (rows[0]!.optionDetail as { contract: string }).contract;
    expect(firstContract).toContain(first.slice(2).replaceAll('-', ''));

    // Eleven days on, 19 days are left: the roll closes it...
    clock = Date.parse('2026-10-26T14:31:00Z');
    const atm2 = Math.round((await ztstaPrice()).toNumber());
    listAndQuote(first, atm2, fair(atm2), { fillAtMid: true });
    listAndQuote(later, atm2, fair(atm2), { fillAtMid: true });
    await pass();
    rows = await intents(s.id);
    const close = rows.find((r) => r.phase === 'flatten');
    expect(close?.closeReason).toMatch(/^Rolled: the contract has 19 days or fewer/);
    await fake.tick();
    clock += 5_000;
    await pass();
    clock += 5_000;
    await pass();
    // ...and opens the later expiry from the Entry's rule, in the same cycle.
    rows = await intents(s.id);
    const reopened = rows.filter((r) => r.phase === 'entry').at(-1)!;
    expect((reopened.optionDetail as { contract: string; roll?: number }).roll).toBe(1);
    expect((reopened.optionDetail as { contract: string }).contract).toContain(
      later.slice(2).replaceAll('-', ''),
    );
    await fake.tick();
    clock += 5_000;
    await pass();
    const cs = await cycles(s.id);
    expect(cs).toHaveLength(1);
    expect(cs[0]?.status).toBe('open');
    await stop(s.id);
  });
});
