import { createDefinition, type AccountCapabilities, type StrategyDefinition } from '@tm/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPlatform,
  loadPlatformToCheck,
  recordPlatformCheck,
  updateAccount,
} from '../src/brokers';
import type { Transaction } from '../src/client';
import { createCredential } from '../src/credentials';
import { listOfferedPlans, loadEntitlement, loadUsage, PlanLimitError } from '../src/entitlements';
import { createFeed } from '../src/feeds';
import { provisionWorkspace } from '../src/provision';
import { entitlements, instruments, plans, tradingAccounts, users } from '../src/schema';
import { generateCredentialKeyPair } from '../src/sealed';
import {
  createStrategy,
  deleteStrategy,
  duplicateStrategy,
  startStrategy,
  updateStrategy,
} from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let free: string;
let pro: string;
let freeAccount: string;
let demoA: string;
const keys = generateCredentialKeyPair();

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

async function planLimit(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, 'expected a plan limit').toBeInstanceOf(PlanLimitError);
  return error as PlanLimitError;
}

function definition(accountId: string): StrategyDefinition {
  const def = createDefinition();
  const series = {
    instrumentId: demoA,
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
    instrumentId: demoA,
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

async function start(userId: string, name: string, accountId: string) {
  let s = await as(userId, (tx) =>
    createStrategy(tx, userId, { name, definition: definition(accountId) }),
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

async function alpacaKey(userId: string) {
  return as(userId, (tx) =>
    createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Alpaca key',
      fields: { keyId: 'PKTESTKEYID00000001', secretKey: 'test-secret-value-0000000000000001' },
      publicKey: keys.publicKey,
    }),
  );
}

const US: AccountCapabilities = {
  assetClasses: ['stock', 'etf'],
  orderTypes: ['market', 'limit'],
  timeInForce: ['day', 'gtc'],
  sides: ['buy', 'sell'],
  extendedHours: false,
  shortSelling: false,
  fractionalQuantity: true,
  atomicMultiLeg: false,
  coverage: 'us',
};

beforeAll(async () => {
  t = await createTestDatabase();
  // The harness starts workspaces on the dev plan; here the catalog's real default applies.
  await t.owner.db.execute(sql`update plan set is_default = false`);
  await t.owner.db.execute(sql`update plan set is_default = true where code = 'free'`);
  free = await createUser('plan-free@example.test');
  pro = await createUser('plan-pro@example.test');
  await provisionWorkspace(t.app.db, { userId: free, displayName: 'Free' });
  await provisionWorkspace(t.app.db, { userId: pro, displayName: 'Pro', planCode: 'pro' });
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
  freeAccount = (await as(free, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('plan catalog', () => {
  it('offers Free and Pro, and starts new workspaces on Free', async () => {
    const offered = await as(free, listOfferedPlans);
    expect(offered.map((p) => [p.code, p.priceMinor])).toEqual([
      ['free', 0],
      ['pro', 2000],
    ]);
    expect(offered[0]?.limits).toMatchObject({
      savedStrategies: 3,
      activeStrategies: 1,
      backtestRunsPerDay: 10,
      connectedAccounts: 1,
      paperIntegrations: false,
      realIntegrations: false,
    });
    expect(await as(free, loadEntitlement)).toMatchObject({ planCode: 'free', planName: 'Free' });
    expect(await as(pro, loadEntitlement)).toMatchObject({ planCode: 'pro' });
  });

  it('is read-only to the app, and no plan can allow real-money trading', async () => {
    await expect(as(free, (tx) => tx.update(plans).set({ priceMinor: 0 }))).rejects.toThrow();
    await expect(
      as(free, (tx) => tx.update(entitlements).set({ planCode: 'pro' })),
    ).rejects.toThrow();
    await expect(
      t.owner.db
        .update(plans)
        .set({ limits: { realIntegrations: true } })
        .where(eq(plans.code, 'pro')),
    ).rejects.toMatchObject({ cause: { constraint_name: 'plan_paper_only' } });
  });
});

describe('limits', () => {
  it('keeps the saved strategies within the plan, counting copies and freeing deleted ones', async () => {
    const a = await as(free, (tx) => createStrategy(tx, free, { name: 'One' }));
    await as(free, (tx) => createStrategy(tx, free, { name: 'Two' }));
    await as(free, (tx) => duplicateStrategy(tx, free, a.id));
    const e = await planLimit(as(free, (tx) => createStrategy(tx, free, { name: 'Four' })));
    expect(e.details).toEqual({
      limit: 'savedStrategies',
      planCode: 'free',
      planName: 'Free',
      allowed: 3,
      used: 3,
    });
    expect(e.message).toMatch(/Free plan keeps up to 3 strategies/);
    await planLimit(as(free, (tx) => duplicateStrategy(tx, free, a.id)));

    await as(free, (tx) => deleteStrategy(tx, free, a.id, { rowVersion: a.rowVersion }));
    await as(free, (tx) => createStrategy(tx, free, { name: 'Four' }));
    expect((await as(free, loadUsage)).savedStrategies).toBe(3);
  });

  it("applies a change to the catalog at once, without touching anyone's entitlement", async () => {
    await t.owner.db.execute(
      sql`update plan set limits = jsonb_set(limits, '{savedStrategies}', '10') where code = 'free'`,
    );
    await as(free, (tx) => createStrategy(tx, free, { name: 'Five' }));
    expect((await as(free, loadEntitlement)).limits.savedStrategies).toBe(10);
  });

  it('runs only as many strategies at once as the plan allows', async () => {
    await start(free, 'Runner', freeAccount);
    const e = await planLimit(start(free, 'Second runner', freeAccount));
    expect(e.details).toMatchObject({ limit: 'activeStrategies', allowed: 1, used: 1 });
  });

  it('keeps Free on the demo broker and feed', async () => {
    const credential = await alpacaKey(free);
    const platform = await planLimit(
      as(free, (tx) =>
        createPlatform(tx, {
          userId: free,
          name: 'Alpaca',
          provider: 'alpaca',
          credentialId: credential.id,
        }),
      ),
    );
    expect(platform.details).toMatchObject({ limit: 'paperIntegrations', allowed: false });
    const feed = await planLimit(
      as(free, (tx) =>
        createFeed(tx, {
          userId: free,
          name: 'Alpaca data',
          provider: 'alpaca',
          credentialId: credential.id,
          assetClasses: ['stock'],
        }),
      ),
    );
    expect(feed.details).toMatchObject({ limit: 'liveData' });
  });

  it('leaves an account past the limit off, and refuses to turn it on', async () => {
    // Pro with a per-user exception: two active accounts, the demo one and one more.
    await t.owner.db
      .update(entitlements)
      .set({ overrides: { connectedAccounts: 2 } })
      .where(eq(entitlements.userId, pro));
    const credential = await alpacaKey(pro);
    const platform = await as(pro, (tx) =>
      createPlatform(tx, {
        userId: pro,
        name: 'Alpaca',
        provider: 'alpaca',
        credentialId: credential.id,
      }),
    );
    await asWorker(pro, async (tx) => {
      await recordPlatformCheck(tx, {
        userId: pro,
        platform: (await loadPlatformToCheck(tx, platform.id))!,
        now: new Date(),
        ok: true,
        accounts: ['PA0000000001', 'PA0000000002'].map((externalId) => ({
          externalId,
          displayId: `••••${externalId.slice(-4)}`,
          currency: 'USD',
          nickname: `Alpaca paper ••••${externalId.slice(-4)}`,
          capabilities: US,
        })),
      });
    });
    const accounts = await as(pro, (tx) =>
      tx
        .select()
        .from(tradingAccounts)
        .where(eq(tradingAccounts.brokerConnectionId, platform.id))
        .orderBy(tradingAccounts.externalId),
    );
    expect(accounts.map((a) => a.isActive)).toEqual([true, false]);
    const off = accounts[1]!;
    const e = await planLimit(
      as(pro, (tx) =>
        updateAccount(tx, { userId: pro, id: off.id, rowVersion: off.rowVersion, active: true }),
      ),
    );
    expect(e.details).toMatchObject({ limit: 'connectedAccounts', allowed: 2, used: 2 });
  });
});
