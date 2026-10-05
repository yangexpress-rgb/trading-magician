import { createDefinition, type AccountCapabilities, type StrategyDefinition } from '@tm/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimBrokerChecks,
  createPlatform,
  deletePlatform,
  listPlatforms,
  loadAccountRouting,
  loadPlatformToCheck,
  recordPlatformCheck,
  setPlatformActive,
  updateAccount,
} from '../src/brokers';
import type { Transaction } from '../src/client';
import { createCredential } from '../src/credentials';
import { registerInstrument } from '../src/instruments';
import { IntegrationError } from '../src/feeds';
import { provisionWorkspace } from '../src/provision';
import { instruments, notifications, strategyRuntimes, users } from '../src/schema';
import { generateCredentialKeyPair } from '../src/sealed';
import {
  createStrategy,
  getStrategy,
  startStrategy,
  updateStrategy,
  validateStoredStrategy,
} from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;
let demoA: string;
/** A made-up US listing for the Alpaca accounts, which cannot trade demo instruments. */
let usA: string;
const keys = generateCredentialKeyPair();

const US: AccountCapabilities = {
  assetClasses: ['stock', 'etf'],
  orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  timeInForce: ['day', 'gtc', 'ioc', 'fok'],
  sides: ['buy', 'sell'],
  extendedHours: false,
  shortSelling: false,
  fractionalQuantity: true,
  atomicMultiLeg: false,
  coverage: 'us',
};

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asWorker = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.worker.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

async function expectIntegrationError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(IntegrationError);
  expect((error as IntegrationError).code).toBe(code);
  return error as IntegrationError;
}

function definition(accountId: string, instrumentId = demoA): StrategyDefinition {
  const def = createDefinition();
  const series = {
    instrumentId,
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
    instrumentId,
    accountId,
    quantity: { type: 'units' as const, value: '1', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    extendedHours: false,
    timing: { mode: 'immediate' as const },
    timingOnly: false,
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell', side: 'sell', ...leg }];
  return def;
}

async function runningStrategy(
  userId: string,
  name: string,
  accountId: string,
  instrumentId = demoA,
) {
  let s = await as(userId, (tx) =>
    createStrategy(tx, userId, { name, definition: definition(accountId, instrumentId) }),
  );
  s = await as(userId, (tx) =>
    updateStrategy(tx, userId, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
  );
  return as(userId, (tx) =>
    startStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      confirmed: true,
      acknowledgedWarnings: ['no_backtest'],
    }),
  );
}

async function addAlpaca(userId: string, name = 'Alpaca') {
  const credential = await as(userId, (tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: `${name} key`,
      fields: { keyId: 'PKTESTKEYID00000001', secretKey: 'test-secret-value-0000000000000001' },
      publicKey: keys.publicKey,
    }),
  );
  return as(userId, (tx) =>
    createPlatform(tx, { userId, name, provider: 'alpaca', credentialId: credential.id }),
  );
}

/** What the worker does after a successful check: record it with the discovered account. */
async function discover(userId: string, platformId: string, externalId: string) {
  await asWorker(userId, async (tx) => {
    const platform = await loadPlatformToCheck(tx, platformId);
    await recordPlatformCheck(tx, {
      userId,
      platform: platform!,
      now: new Date(),
      ok: true,
      accounts: [
        {
          externalId,
          displayId: `••••${externalId.slice(-4)}`,
          currency: 'USD',
          nickname: `Alpaca paper ••••${externalId.slice(-4)}`,
          capabilities: US,
        },
      ],
    });
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('brokers-a@example.test');
  userB = await createUser('brokers-b@example.test');
  for (const userId of [userA, userB]) {
    await provisionWorkspace(t.app.db, { userId, displayName: 'Test' });
  }
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
  usA = await asWorker(userA, (tx) =>
    registerInstrument(tx, {
      assetClass: 'stock',
      symbol: 'ZTSTA',
      venue: 'NASDAQ',
      displayName: 'Test Company A',
      provider: 'alpaca',
      providerId: 'asset-ztsta',
    }),
  );
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('trading platforms', () => {
  it('starts with the demo platform and its default paper account', async () => {
    const [demo] = await as(userA, listPlatforms);
    expect(demo).toMatchObject({ provider: 'demo', environment: 'paper', isActive: true });
    expect(demo!.accounts).toHaveLength(1);
    expect(demo!.accounts[0]).toMatchObject({
      isDefault: true,
      mode: 'paper',
      capabilities: { extendedHours: false, coverage: 'demo' },
    });
  });

  it('needs a stored key for Alpaca and refuses unknown providers', async () => {
    await expectIntegrationError(
      as(userA, (tx) =>
        createPlatform(tx, {
          userId: userA,
          name: 'No key',
          provider: 'alpaca',
          credentialId: null,
        }),
      ),
      'bad_request',
    );
    await expectIntegrationError(
      as(userA, (tx) =>
        createPlatform(tx, { userId: userA, name: 'X', provider: 'nope', credentialId: null }),
      ),
      'bad_request',
    );
  });

  it('is checked by the worker, which discovers its paper account once', async () => {
    const platform = await addAlpaca(userA, 'Alpaca discovery');
    expect(platform).toMatchObject({ checking: true, accounts: [], health: 'unknown' });

    const claimed = await claimBrokerChecks(t.worker.db, {
      leaseSeconds: 30,
      everySeconds: 300,
      limit: 50,
    });
    expect(claimed).toContainEqual({ platformId: platform.id, userId: userA });

    await discover(userA, platform.id, 'acct-0000-0042');
    await discover(userA, platform.id, 'acct-0000-0042');
    const after = (await as(userA, listPlatforms)).find((p) => p.id === platform.id)!;
    expect(after).toMatchObject({ health: 'healthy', checking: false, lastError: null });
    expect(after.accounts).toHaveLength(1);
    expect(after.accounts[0]).toMatchObject({
      nickname: 'Alpaca paper ••••0042',
      maskedExternalId: '••••0042',
      isDefault: false,
      capabilities: { coverage: 'us' },
    });

    // Not visible to anyone else.
    expect((await as(userB, listPlatforms)).map((p) => p.id)).not.toContain(platform.id);
  });

  it('announces a platform that stops answering', async () => {
    const platform = await addAlpaca(userA, 'Alpaca flaky');
    await discover(userA, platform.id, 'acct-0000-0077');
    await asWorker(userA, async (tx) => {
      const p = await loadPlatformToCheck(tx, platform.id);
      await recordPlatformCheck(tx, {
        userId: userA,
        platform: p!,
        now: new Date(),
        ok: false,
        error: 'The provider could not be reached',
      });
    });
    const rows = await as(userA, (tx) =>
      tx.select().from(notifications).where(eq(notifications.resourceId, platform.id)),
    );
    expect(rows.map((r) => r.title)).toEqual(['Alpaca flaky is not responding']);
  });
});

describe('accounts', () => {
  it('makes a new default and moves strategies that are not running', async () => {
    const platform = await addAlpaca(userB, 'Alpaca B');
    await discover(userB, platform.id, 'acct-b-0001');
    const [demo] = await as(userB, listPlatforms);
    const demoAccount = demo!.accounts[0]!;
    const alpacaAccount = (await as(userB, listPlatforms)).find((p) => p.id === platform.id)!
      .accounts[0]!;

    const idle = await as(userB, (tx) =>
      createStrategy(tx, userB, { name: 'Idle', definition: definition(demoAccount.id) }),
    );
    const running = await runningStrategy(userB, 'Running', demoAccount.id);

    const result = await as(userB, (tx) =>
      updateAccount(tx, {
        userId: userB,
        id: alpacaAccount.id,
        rowVersion: alpacaAccount.rowVersion,
        makeDefault: true,
        migrateStrategies: true,
      }),
    );
    expect(result).toMatchObject({ account: { isDefault: true }, migrated: 1, skipped: 1 });

    const accounts = (await as(userB, listPlatforms)).flatMap((p) => p.accounts);
    expect(accounts.filter((a) => a.isDefault).map((a) => a.id)).toEqual([alpacaAccount.id]);
    const moved = await as(userB, (tx) => getStrategy(tx, idle.id));
    expect(moved.definition.entry.orders[0]!.accountId).toBe(alpacaAccount.id);
    const kept = await as(userB, (tx) => getStrategy(tx, running.id));
    expect(kept.definition.entry.orders[0]!.accountId).toBe(demoAccount.id);

    // The router sees the account with its platform and stored key.
    const routing = (await as(userB, (tx) => loadAccountRouting(tx, [alpacaAccount.id]))).get(
      alpacaAccount.id,
    );
    expect(routing).toMatchObject({
      provider: 'alpaca',
      platformActive: true,
      externalId: 'acct-b-0001',
    });
    expect(routing?.credentialRef).toEqual(expect.any(String));

    // A platform holding the default, or used by strategies, cannot be removed.
    await expectIntegrationError(
      as(userB, (tx) => deletePlatform(tx, { userId: userB, id: platform.id })),
      'conflict',
    );
    await expectIntegrationError(
      as(userB, (tx) => deletePlatform(tx, { userId: userB, id: demo!.id })),
      'conflict',
    );
  });

  it('asks before turning off an account in use, then pauses its strategy', async () => {
    const platform = await addAlpaca(userA, 'Alpaca in use');
    await discover(userA, platform.id, 'acct-a-0009');
    const account = (await as(userA, listPlatforms)).find((p) => p.id === platform.id)!
      .accounts[0]!;
    const s = await runningStrategy(userA, 'Uses Alpaca', account.id, usA);

    const refused = await expectIntegrationError(
      as(userA, (tx) =>
        updateAccount(tx, {
          userId: userA,
          id: account.id,
          rowVersion: account.rowVersion,
          active: false,
        }),
      ),
      'invalid_state',
    );
    expect(refused.message).toContain('Uses Alpaca trades through Alpaca paper ••••0009');

    await as(userA, (tx) =>
      updateAccount(tx, {
        userId: userA,
        id: account.id,
        rowVersion: account.rowVersion,
        active: false,
        pauseStrategies: true,
      }),
    );
    const [runtime] = await as(userA, (tx) =>
      tx.select().from(strategyRuntimes).where(eq(strategyRuntimes.strategyId, s.id)),
    );
    expect(runtime).toMatchObject({
      status: 'paused',
      pauseReason: 'Its trading account Alpaca paper ••••0009 was turned off.',
    });

    // Turning the account back on is allowed; the default must be active.
    const off = (await as(userA, listPlatforms)).find((p) => p.id === platform.id)!.accounts[0]!;
    expect(off.isActive).toBe(false);
    await expectIntegrationError(
      as(userA, (tx) =>
        updateAccount(tx, {
          userId: userA,
          id: off.id,
          rowVersion: off.rowVersion,
          makeDefault: true,
        }),
      ),
      'invalid_state',
    );
  });

  it('turns a whole platform off only with consent when strategies use it', async () => {
    const platform = await addAlpaca(userA, 'Alpaca platform off');
    await discover(userA, platform.id, 'acct-a-0011');
    const account = (await as(userA, listPlatforms)).find((p) => p.id === platform.id)!
      .accounts[0]!;
    const s = await runningStrategy(userA, 'Platform user', account.id, usA);

    await expectIntegrationError(
      as(userA, (tx) => setPlatformActive(tx, { userId: userA, id: platform.id, active: false })),
      'invalid_state',
    );
    const off = await as(userA, (tx) =>
      setPlatformActive(tx, {
        userId: userA,
        id: platform.id,
        active: false,
        pauseStrategies: true,
      }),
    );
    expect(off.isActive).toBe(false);
    const [runtime] = await as(userA, (tx) =>
      tx.select().from(strategyRuntimes).where(eq(strategyRuntimes.strategyId, s.id)),
    );
    expect(runtime?.pauseReason).toBe('Its trading platform Alpaca platform off was turned off.');

    // Routing reports the platform as off, so the runtime will not place orders through it.
    const routing = (await as(userA, (tx) => loadAccountRouting(tx, [account.id]))).get(account.id);
    expect(routing?.platformActive).toBe(false);
  });

  it('catches legs that send demo instruments to a US account, and the reverse', async () => {
    const platform = await addAlpaca(userA, 'Alpaca venues');
    await discover(userA, platform.id, 'acct-a-0015');
    const [demo, ...rest] = await as(userA, listPlatforms);
    const alpaca = rest.find((p) => p.id === platform.id)!.accounts[0]!;
    const codes = async (accountId: string, instrumentId: string) => {
      const s = await as(userA, (tx) =>
        createStrategy(tx, userA, {
          name: 'Venues',
          definition: definition(accountId, instrumentId),
        }),
      );
      const { validation } = await as(userA, (tx) => validateStoredStrategy(tx, s.id));
      return validation.errors.map((i) => i.code);
    };
    expect(await codes(alpaca.id, demoA)).toContain('unsupported_venue');
    expect(await codes(demo!.accounts[0]!.id, usA)).toContain('unsupported_venue');
    expect(await codes(alpaca.id, usA)).not.toContain('unsupported_venue');
  });

  it('removes an unused platform with its accounts', async () => {
    const platform = await addAlpaca(userA, 'Alpaca spare');
    await discover(userA, platform.id, 'acct-a-0013');
    await as(userA, (tx) => deletePlatform(tx, { userId: userA, id: platform.id }));
    expect((await as(userA, listPlatforms)).map((p) => p.id)).not.toContain(platform.id);
  });
});
