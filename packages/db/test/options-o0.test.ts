import {
  BrokerRejectedError,
  createDefinition,
  type AccountCapabilities,
  type BrokerAdapter,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, loadPlatformToCheck, recordPlatformCheck } from '../src/brokers';
import type { Transaction } from '../src/client';
import { createCredential } from '../src/credentials';
import { registerInstrument } from '../src/instruments';
import { recordBrokerFigures } from '../src/live-gate';
import {
  ensureOptionInstrument,
  isOptionsAccount,
  optionsAccountView,
  optionsUses,
} from '../src/options-trading';
import { provisionWorkspace } from '../src/provision';
import { reconcileAccount } from '../src/reconcile';
import {
  entitlements,
  executionIncidents,
  instruments,
  strategyRuntimes,
  tradingAccounts,
  users,
} from '../src/schema';
import { generateCredentialKeyPair } from '../src/sealed';
import { createStrategy, startStrategy, StrategyError, updateStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Options trading brief v0.2, Phase O0 (ADR 0123): contracts as Core
 * instruments (§5.3), the options level read from the broker (§5.4), the
 * Start gates and the account-isolation rule (§5.6, A10), and reconciliation
 * of an OCC holding created outside the app (A11).
 */

let t: TestDatabase;
let userId: string;
let optionsAccount: string;
let equityAccount: string;
let demoAccount: string;
let underlying: string;
const keys = generateCredentialKeyPair();

const US: AccountCapabilities = {
  assetClasses: ['stock', 'etf'],
  orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  timeInForce: ['day', 'gtc', 'ioc', 'fok'],
  sides: ['buy', 'sell'],
  extendedHours: false,
  shortSelling: false,
  fractionalQuantity: false,
  atomicMultiLeg: false,
  coverage: 'us',
};

const as = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
const asWorker = <T>(fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.worker.db, { userId }, fn);
const optionsOn = () => {
  process.env.OPTIONS_TRADING_ENABLED = 'true';
};
const optionsOff = () => {
  delete process.env.OPTIONS_TRADING_ENABLED;
};

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

async function paperAccount(name: string, externalId: string): Promise<string> {
  const credential = await as((tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: `${name} key`,
      fields: { keyId: 'PKTESTKEYID00000001', secretKey: 'test-secret-value-0000000000000001' },
      publicKey: keys.publicKey,
    }),
  );
  const platform = await as((tx) =>
    createPlatform(tx, { userId, name, provider: 'alpaca', credentialId: credential.id }),
  );
  await asWorker(async (tx) => {
    const p = await loadPlatformToCheck(tx, platform.id);
    await recordPlatformCheck(tx, {
      userId,
      platform: p!,
      now: new Date(),
      ok: true,
      accounts: [
        {
          externalId,
          displayId: `••••${externalId.slice(-4)}`,
          currency: 'USD',
          nickname: name,
          capabilities: US,
        },
      ],
    });
  });
  const [row] = await t.owner.db
    .select({ id: tradingAccounts.id })
    .from(tradingAccounts)
    .where(and(eq(tradingAccounts.userId, userId), eq(tradingAccounts.externalId, externalId)));
  return row!.id;
}

function definition(accountId: string, option?: 'long' | 'combo'): StrategyDefinition {
  const def = createDefinition();
  const series = {
    instrumentId: underlying,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  const cmp = (id: string) => ({
    kind: 'comparison' as const,
    id,
    operator: 'lt' as const,
    left: { kind: 'market' as const, id: `${id}-px`, ...series },
    right: { kind: 'constant' as const, id: `${id}-k`, value: '1' },
  });
  def.entry.condition.children = [cmp('in')];
  def.exit.condition.children = [cmp('out')];
  const leg = {
    instrumentId: underlying,
    accountId,
    quantity: { type: 'units' as const, value: '1', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  const opt: PlannedOrder['option'] = {
    right: 'call',
    strikeRule: { type: 'moneynessPct', pct: 5 },
    expiryRule: { targetDte: 30, minDte: 7 },
  };
  def.entry.orders = [
    { id: 'buy', legLabel: 'Buy', side: 'buy', ...leg, ...(option ? { option: opt } : {}) },
  ];
  if (option === 'combo')
    def.entry.orders.push({
      id: 'write',
      legLabel: 'Write',
      side: 'sell_short',
      ...leg,
      option: { ...opt, strikeRule: { type: 'moneynessPct', pct: 10 } },
    });
  def.exit.orders = [
    { id: 'sell', legLabel: 'Sell', side: 'sell', ...leg, ...(option ? { option: opt } : {}) },
  ];
  return def;
}

async function strategy(name: string, def: StrategyDefinition) {
  let s = await as((tx) => createStrategy(tx, userId, { name, definition: def }));
  s = await as((tx) =>
    updateStrategy(tx, userId, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
  );
  return s;
}

const start = (s: { id: string; rowVersion: number }, accountId: string) =>
  as((tx) =>
    startStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      confirmed: true,
      acknowledgedWarnings: ['no_backtest', 'non_atomic_multi_leg'],
      accountId,
    }),
  );

const setLevel = (accountId: string, level: number | null) =>
  t.owner.db
    .update(tradingAccounts)
    .set({ brokerOptionsLevel: level })
    .where(eq(tradingAccounts.id, accountId));

beforeAll(async () => {
  t = await createTestDatabase();
  const [u] = await t.auth.db
    .insert(users)
    .values({ name: 'options', email: 'options-o0@example.test' })
    .returning({ id: users.id });
  userId = u!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Test' });
  await t.owner.db.update(entitlements).set({ overrides: { connectedAccounts: 10 } });
  underlying = await asWorker((tx) =>
    registerInstrument(tx, {
      assetClass: 'stock',
      symbol: 'ZOPT',
      venue: 'NASDAQ',
      displayName: 'Options Test Company',
      provider: 'alpaca',
      providerId: 'asset-zopt',
    }),
  );
  optionsAccount = await paperAccount('Options paper', 'acct-opts-0001');
  equityAccount = await paperAccount('Equity paper', 'acct-eqty-0002');
  const [demo] = await t.owner.db
    .select({ id: tradingAccounts.id })
    .from(tradingAccounts)
    .where(and(eq(tradingAccounts.userId, userId), eq(tradingAccounts.externalId, 'demo')));
  demoAccount =
    demo?.id ??
    (
      await t.owner.db
        .select({ id: tradingAccounts.id })
        .from(tradingAccounts)
        .where(eq(tradingAccounts.userId, userId))
    ).find((a) => a.id !== optionsAccount && a.id !== equityAccount)!.id;
}, 60_000);

afterEach(optionsOff);
afterAll(async () => {
  optionsOff();
  await t?.drop();
});

describe('contracts are Core instruments (§5.3)', () => {
  const contract = {
    symbol: 'ZOPT261218C00105000',
    expiry: '2026-12-18',
    strike: '105',
    right: 'call' as const,
    multiplier: '100',
    provider: 'alpaca',
    providerId: 'ZOPT261218C00105000',
  };

  it('inserts once and returns the same row however often, or at once, it is asked', async () => {
    const ids = await Promise.all(
      [1, 2, 3, 4].map(() =>
        asWorker((tx) => ensureOptionInstrument(tx, { ...contract, underlyingId: underlying })),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const [row] = await t.owner.db.select().from(instruments).where(eq(instruments.id, ids[0]!));
    expect(row).toMatchObject({
      assetClass: 'option',
      symbol: 'ZOPT261218C00105000',
      venue: 'OPRA',
      multiplier: '100',
      underlyingId: underlying,
      expiry: '2026-12-18',
      optionRight: 'call',
      displayName: 'ZOPT 105 call 2026-12-18',
    });
    expect(Number(row!.strike)).toBe(105);
  });

  it('is refused for the web, for a symbol that is not OCC and for a demo underlying', async () => {
    const web = await errorOf(
      as((tx) => ensureOptionInstrument(tx, { ...contract, underlyingId: underlying })),
    );
    expect(String((web as Error).cause ?? web)).toMatch(/permission denied/);
    const bad = await errorOf(
      asWorker((tx) =>
        ensureOptionInstrument(tx, { ...contract, symbol: 'ZOPT', underlyingId: underlying }),
      ),
    );
    expect(String((bad as Error).cause ?? bad)).toMatch(/invalid option contract/);
  });
});

describe('the options level is read from the broker, never assumed (§5.4)', () => {
  it('keeps what the broker last reported and nothing when it says nothing', async () => {
    await setLevel(optionsAccount, null);
    await asWorker((tx) =>
      recordBrokerFigures(tx, optionsAccount, { currency: 'USD', cash: '1', equity: '1' }),
    );
    expect((await as((tx) => optionsAccountView(tx, optionsAccount))).optionsLevel).toBeUndefined();
    await asWorker((tx) =>
      recordBrokerFigures(tx, optionsAccount, {
        currency: 'USD',
        cash: '1',
        equity: '1',
        optionsLevel: 3,
      }),
    );
    expect((await as((tx) => optionsAccountView(tx, optionsAccount))).optionsLevel).toBe(3);
  });
});

describe('Start gates and account isolation (§§5.4–5.6, A10)', () => {
  it('says what a definition does with options', () => {
    expect(optionsUses(definition(equityAccount))).toEqual([]);
    expect(optionsUses(definition(optionsAccount, 'long'))).toEqual(['long']);
    expect(optionsUses(definition(optionsAccount, 'combo'))).toEqual(['long', 'combo']);
  });

  it('refuses an options run while the switch is off, whatever the account', async () => {
    const s = await strategy('Options off', definition(optionsAccount, 'long'));
    const e = await errorOf(start(s, optionsAccount));
    expect(e).toBeInstanceOf(StrategyError);
    expect((e as Error).message).toMatch(/Options trading is turned off on this server/);
  });

  it('refuses an options run at level 0, a combo at level 2, and on the simulator', async () => {
    optionsOn();
    await setLevel(optionsAccount, 0);
    const long = await strategy('Long call', definition(optionsAccount, 'long'));
    const level0 = await errorOf(start(long, optionsAccount));
    expect(((level0 as StrategyError).details as { reason?: string } | undefined)?.reason).toBe(
      'options_level',
    );
    expect((level0 as Error).message).toBe(
      'Options paper is at options level 0 (no options trading); this strategy needs level 2 (buying calls and puts).',
    );

    await setLevel(optionsAccount, 2);
    const combo = await strategy('Call spread', definition(optionsAccount, 'combo'));
    const level2 = await errorOf(start(combo, optionsAccount));
    expect(((level2 as StrategyError).details as { reason?: string } | undefined)?.reason).toBe(
      'options_level',
    );
    expect((level2 as Error).message).toMatch(/needs level 3 \(spreads\)/);

    const sim = await errorOf(start(long, demoAccount));
    expect(((sim as StrategyError).details as { reason?: string } | undefined)?.reason).toBe(
      'options_simulator',
    );
    expect((sim as Error).message).toMatch(/doesn't trade options/);
  });

  it('passes the options gates at a level that covers the strategy (validation decides the rest)', async () => {
    optionsOn();
    await setLevel(optionsAccount, 2);
    const long = await strategy('Long call 2', definition(optionsAccount, 'long'));
    const e = await errorOf(start(long, optionsAccount));
    // O0 builds no options orders: the gates pass and validation refuses the leg.
    expect(((e as StrategyError).details as { reason?: string } | undefined)?.reason).not.toMatch(
      /^options_|equity_account/,
    );
    expect(JSON.stringify((e as StrategyError).details)).toMatch(/options_not_built/);
  });

  it('starts stock and ETF strategies normally on the same accounts', async () => {
    optionsOn();
    const s = await strategy('Plain equity', definition(equityAccount));
    const started = await start(s, equityAccount);
    expect(started.status).toBe('actively_executing');
    const [run] = await t.owner.db
      .select({ tradesOptions: strategyRuntimes.tradesOptions })
      .from(strategyRuntimes)
      .where(eq(strategyRuntimes.strategyId, s.id));
    expect(run?.tradesOptions).toBe(false);
  });

  it('keeps options runs and stock/ETF runs on separate accounts, both ways', async () => {
    optionsOn();
    await setLevel(optionsAccount, 3);
    await setLevel(equityAccount, 3);
    // An equity run is live on the equity account (previous test): no options run may join it.
    const long = await strategy('Long call 3', definition(equityAccount, 'long'));
    const joined = await errorOf(start(long, equityAccount));
    expect(((joined as StrategyError).details as { reason?: string } | undefined)?.reason).toBe(
      'options_account_has_equity_runs',
    );
    expect((joined as Error).message).toMatch(/runs stock and ETF strategies/);

    // An options run on the options account. O0 places no options order, so a
    // run is started there and then marked as trading options directly.
    const holder = await strategy('Options holder', definition(optionsAccount));
    await start(holder, optionsAccount);
    await t.owner.db
      .update(strategyRuntimes)
      .set({ tradesOptions: true })
      .where(eq(strategyRuntimes.strategyId, holder.id));
    expect(await as((tx) => isOptionsAccount(tx, optionsAccount))).toBe(true);
    const equity = await strategy('Equity onto options', definition(optionsAccount));
    const refused = await errorOf(start(equity, optionsAccount));
    expect(((refused as StrategyError).details as { reason?: string } | undefined)?.reason).toBe(
      'equity_account_has_options_runs',
    );
    expect((refused as Error).message).toBe(
      "Options paper trades options, so stock and ETF strategies can't run on it. Choose another account.",
    );
  });
});

describe('reconciliation of an OCC holding (A11)', () => {
  const occ = 'ZOPT261218P00095000';
  const broker = (holding: string): BrokerAdapter => ({
    id: 'stub',
    capabilities: {
      orderTypes: ['market'],
      timeInForce: ['day'],
      extendedHours: false,
      fractionalQuantities: false,
      shortSelling: false,
      atomicMultiLeg: false,
    },
    submitOrder: () => Promise.reject(new BrokerRejectedError('x', 'x')),
    cancelOrder: () => Promise.resolve(),
    updates: () => Promise.resolve({ updates: [], cursor: undefined }),
    orderUpdates: () => Promise.resolve([]),
    positions: () => Promise.resolve([{ instrumentId: holding, quantity: '1', averageCost: '2' }]),
  });

  it('pauses no run on the equity account, and nothing at all once the contract is known', async () => {
    const running = async (accountId: string) =>
      (
        await t.owner.db
          .select({ id: strategyRuntimes.id, status: strategyRuntimes.status })
          .from(strategyRuntimes)
          .where(eq(strategyRuntimes.accountId, accountId))
      ).filter((r) => r.status === 'running');
    const equityBefore = await running(equityAccount);
    expect(equityBefore.length).toBeGreaterThan(0);

    // Registered as the lifecycle job does before reconciling (§5.8): now a known instrument.
    const id = await asWorker((tx) =>
      ensureOptionInstrument(tx, {
        underlyingId: underlying,
        symbol: occ,
        expiry: '2026-12-18',
        strike: '95',
        right: 'put',
        multiplier: '100',
        provider: 'alpaca',
        providerId: occ,
      }),
    );
    const r = await asWorker((tx) =>
      reconcileAccount(tx, broker(id), { userId, accountId: optionsAccount, now: new Date() }),
    );
    expect(r.mismatches).toEqual([
      expect.objectContaining({ kind: 'position', instrumentId: id, symbol: occ }),
    ]);
    // Known: only runs trading that contract would pause, and none does.
    expect((await running(optionsAccount)).length).toBe(1);
    const [incident] = await t.owner.db
      .select()
      .from(executionIncidents)
      .where(eq(executionIncidents.id, r.incidentId!));
    expect(incident?.kind).toBe('reconciliation_mismatch');
    // The equity account's runs are untouched by anything on the options account.
    expect(await running(equityAccount)).toEqual(equityBefore);
  });
});
