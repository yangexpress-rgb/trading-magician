import { createDefinition, type AccountCapabilities, type StrategyDefinition } from '@tm/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setAccountFeeds } from '../src/account-feeds';
import {
  createPlatform,
  getAccount,
  loadPlatformToCheck,
  recordPlatformCheck,
  updateAccount,
} from '../src/brokers';
import type { Transaction } from '../src/client';
import { createCredential } from '../src/credentials';
import { IntegrationError } from '../src/feeds';
import { registerInstrument } from '../src/instruments';
import {
  DELAYED_FEED_TEXT,
  endPilotMode,
  LIVE_OFF_TEXT,
  liveStartProblem,
  recordLiveRefusal,
  setAccountPilot,
} from '../src/live-gate';
import { provisionWorkspace } from '../src/provision';
import { resumeRuntime } from '../src/runtime';
import {
  auditEvents,
  dataFeedConnections,
  entitlements,
  strategyRuntimes,
  tradingAccounts,
  users,
} from '../src/schema';
import { generateCredentialKeyPair } from '../src/sealed';
import { createStrategy, startStrategy, StrategyError, updateStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * The live gate (Phase 7 P3, ADR 0109). A8: with LIVE_TRADING_ENABLED off no
 * live platform can be added. A7: with it on, a live run does not start on a
 * delayed-only chain, and the refusal is recorded.
 */

let t: TestDatabase;
let admin: string;
let member: string;
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

const liveOn = () => {
  process.env.LIVE_TRADING_ENABLED = 'true';
};
const liveOff = () => {
  delete process.env.LIVE_TRADING_ENABLED;
};

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (e: unknown) => e,
  );
}

async function liveKey(userId: string) {
  return as(userId, (tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Live key',
      environment: 'live',
      fields: { keyId: 'AKTESTKEYID00000001', secretKey: 'live-secret-value-0000000000000001' },
      publicKey: keys.publicKey,
    }),
  );
}

/** Adds a live Alpaca platform and records the worker's discovery of its account. */
async function liveAccount(userId: string): Promise<string> {
  const credential = await liveKey(userId);
  const platform = await as(userId, (tx) =>
    createPlatform(tx, {
      userId,
      name: 'Alpaca live',
      provider: 'alpaca',
      credentialId: credential.id,
      environment: 'live',
      acknowledgeRealMoney: true,
    }),
  );
  await asWorker(userId, async (tx) => {
    const p = await loadPlatformToCheck(tx, platform.id);
    await recordPlatformCheck(tx, {
      userId,
      platform: p!,
      now: new Date(),
      ok: true,
      accounts: [
        {
          externalId: 'live-0001',
          displayId: '••••0001',
          currency: 'USD',
          nickname: 'Alpaca live ••••0001',
          capabilities: US,
        },
      ],
    });
  });
  const [row] = await t.owner.db
    .select({ id: tradingAccounts.id })
    .from(tradingAccounts)
    .where(and(eq(tradingAccounts.userId, userId), eq(tradingAccounts.mode, 'live')));
  return row!.id;
}

function definition(accountId: string): StrategyDefinition {
  const def = createDefinition();
  const series = {
    instrumentId: usA,
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
    instrumentId: usA,
    accountId,
    quantity: { type: 'units' as const, value: '1', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell', side: 'sell', ...leg }];
  return def;
}

beforeAll(async () => {
  t = await createTestDatabase();
  admin = await createUser('live-admin@example.test');
  member = await createUser('live-member@example.test');
  for (const userId of [admin, member]) {
    await provisionWorkspace(t.app.db, { userId, displayName: 'Test' });
  }
  await t.owner.db.execute(sql`insert into platform_admin (user_id) values (${admin})`);
  await t.owner.db.update(entitlements).set({ overrides: { connectedAccounts: 10 } });
  usA = await asWorker(admin, (tx) =>
    registerInstrument(tx, {
      assetClass: 'stock',
      symbol: 'ZLIVE',
      venue: 'NASDAQ',
      displayName: 'Live Test Company',
      provider: 'alpaca',
      providerId: 'asset-zlive',
    }),
  );
}, 60_000);

afterEach(liveOff);

afterAll(async () => {
  liveOff();
  await t?.drop();
});

describe('adding a live platform (brief §6)', () => {
  it('is refused while live trading is off on the server (A8)', async () => {
    liveOn();
    const credential = await liveKey(admin);
    liveOff();
    const error = await errorOf(
      as(admin, (tx) =>
        createPlatform(tx, {
          userId: admin,
          name: 'Alpaca live',
          provider: 'alpaca',
          credentialId: credential.id,
          environment: 'live',
          acknowledgeRealMoney: true,
        }),
      ),
    );
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as Error).message).toContain(LIVE_OFF_TEXT);
    const live = await t.owner.db
      .select()
      .from(tradingAccounts)
      .where(eq(tradingAccounts.mode, 'live'));
    expect(live).toEqual([]);
  });

  it('needs a platform admin, a live key and the real-money acknowledgement', async () => {
    liveOn();
    const memberKey = await liveKey(member);
    const refusedMember = await errorOf(
      as(member, (tx) =>
        createPlatform(tx, {
          userId: member,
          name: 'Alpaca live',
          provider: 'alpaca',
          credentialId: memberKey.id,
          environment: 'live',
          acknowledgeRealMoney: true,
        }),
      ),
    );
    expect((refusedMember as Error).message).toBe('Live trading is not open to members yet');

    const adminKey = await liveKey(admin);
    const unacknowledged = await errorOf(
      as(admin, (tx) =>
        createPlatform(tx, {
          userId: admin,
          name: 'Alpaca live',
          provider: 'alpaca',
          credentialId: adminKey.id,
          environment: 'live',
        }),
      ),
    );
    expect((unacknowledged as Error).message).toMatch(/trades real money/);

    // A paper key cannot sign in a live platform.
    const paperKey = await as(admin, (tx) =>
      createCredential(tx, {
        userId: admin,
        provider: 'alpaca',
        label: 'Paper key',
        fields: { keyId: 'PKTESTKEYID00000009', secretKey: 'test-secret-value-0000000000000009' },
        publicKey: keys.publicKey,
      }),
    );
    const wrongKey = await errorOf(
      as(admin, (tx) =>
        createPlatform(tx, {
          userId: admin,
          name: 'Alpaca live',
          provider: 'alpaca',
          credentialId: paperKey.id,
          environment: 'live',
          acknowledgeRealMoney: true,
        }),
      ),
    );
    expect(wrongKey).toBeInstanceOf(IntegrationError);
  });
});

describe('a live account', () => {
  let account: string;

  beforeAll(async () => {
    liveOn();
    account = await liveAccount(admin);
    liveOff();
  });

  it('starts in pilot mode under the default caps and cannot be the default account', async () => {
    const summary = await as(admin, (tx) => getAccount(tx, account));
    expect(summary.mode).toBe('live');
    expect(summary.pilot).toEqual({ maxOrder: '500', maxExposure: '2500' });
    const error = await errorOf(
      as(admin, (tx) =>
        updateAccount(tx, {
          userId: admin,
          id: account,
          rowVersion: summary.rowVersion,
          makeDefault: true,
        }),
      ),
    );
    expect(error).toBeInstanceOf(IntegrationError);
  });

  it('keeps pilot caps within the ceiling, and ends pilot mode only on purpose', async () => {
    await expect(
      as(admin, (tx) =>
        setAccountPilot(tx, admin, account, { maxOrder: '6000', maxExposure: '2500' }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await as(admin, (tx) =>
      setAccountPilot(tx, admin, account, { maxOrder: '250', maxExposure: '1000' }),
    );
    expect((await as(admin, (tx) => getAccount(tx, account))).pilot).toEqual({
      maxOrder: '250',
      maxExposure: '1000',
    });
    const actions = await t.owner.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, account));
    expect(actions.map((a) => a.action)).toContain('trading_account.pilot_changed');
  });

  it('does not start a run on a delayed-only feed, and records the refusal (A7)', async () => {
    liveOn();
    const feeds = await as(admin, (tx) =>
      tx
        .insert(dataFeedConnections)
        .values([
          {
            userId: admin,
            name: 'Delayed feed',
            provider: 'demo',
            assetClasses: ['stock'],
            isRealtime: false,
          },
          {
            userId: admin,
            name: 'Real-time feed',
            provider: 'demo',
            assetClasses: ['stock'],
            isRealtime: true,
          },
        ])
        .returning({ id: dataFeedConnections.id }),
    );
    const [delayed, realtime] = feeds.map((f) => f.id) as [string, string];
    await as(admin, (tx) => setAccountFeeds(tx, admin, account, { feedIds: [delayed] }));

    let s = await as(admin, (tx) =>
      createStrategy(tx, admin, { name: 'Live test', definition: definition(account) }),
    );
    s = await as(admin, (tx) =>
      updateStrategy(tx, admin, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
    );
    const start = (extra: { liveConfirmed?: boolean; mode?: 'paper' | 'live' }) =>
      as(admin, (tx) =>
        startStrategy(tx, admin, s.id, {
          rowVersion: s.rowVersion,
          confirmed: true,
          acknowledgedWarnings: ['no_backtest'],
          accountId: account,
          mode: 'live',
          ...extra,
        }),
      );

    const refused = await errorOf(start({ liveConfirmed: true }));
    expect(refused).toBeInstanceOf(StrategyError);
    expect((refused as Error).message).toBe(DELAYED_FEED_TEXT);
    expect((refused as StrategyError).details).toMatchObject({ reason: 'live_feed_delayed' });
    // The start route records the refusal in its own transaction.
    await as(admin, (tx) =>
      recordLiveRefusal(tx, {
        userId: admin,
        strategyId: s.id,
        accountId: account,
        reason: 'live_feed_delayed',
        message: DELAYED_FEED_TEXT,
      }),
    );
    const [audit] = await t.owner.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, s.id),
          eq(auditEvents.action, 'strategy.live_start_refused'),
        ),
      );
    expect(audit?.context).toMatchObject({ accountId: account, reason: 'live_feed_delayed' });

    // A real-time feed in the chain lets it through, with its own confirmation only.
    await as(admin, (tx) => setAccountFeeds(tx, admin, account, { feedIds: [delayed, realtime] }));
    expect(await as(admin, (tx) => liveStartProblem(tx, account, s.id))).toBeNull();
    const paperMode = await errorOf(start({ liveConfirmed: true, mode: 'paper' }));
    expect((paperMode as StrategyError).details).toMatchObject({ reason: 'mode_mismatch' });
    const unconfirmed = await errorOf(start({}));
    expect((unconfirmed as StrategyError).details).toMatchObject({ reason: 'live_unconfirmed' });

    await start({ liveConfirmed: true });
    const [run] = await t.owner.db
      .select()
      .from(strategyRuntimes)
      .where(eq(strategyRuntimes.strategyId, s.id));
    expect(run?.mode).toBe('live');

    // With the flag off again, the live run does not resume and does not start.
    liveOff();
    expect(await as(admin, (tx) => liveStartProblem(tx, account, s.id))).toMatchObject({
      reason: 'live_disabled',
    });
    await t.owner.db
      .update(strategyRuntimes)
      .set({ status: 'paused', pauseReason: 'test' })
      .where(eq(strategyRuntimes.id, run!.id));
    expect(await asWorker(admin, (tx) => resumeRuntime(tx, admin, run!.id))).toBe(false);
  });

  it('keeps the account and its runs live in the database', async () => {
    await expect(
      t.ownerSql`update trading_account set mode = 'paper' where id = ${account}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      t.ownerSql`update strategy_runtime set mode = 'paper' where account_id = ${account}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ends pilot mode as a separate action, with a notification', async () => {
    await as(admin, (tx) => endPilotMode(tx, admin, account));
    expect((await as(admin, (tx) => getAccount(tx, account))).pilot).toBeNull();
  });
});
