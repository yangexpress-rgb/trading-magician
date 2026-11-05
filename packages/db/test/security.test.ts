import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { DEMO_INSTRUMENTS } from '../src/demo';
import { provisionWorkspace } from '../src/provision';
import {
  auditEvents,
  brokerConnections,
  dataFeedConnections,
  dataRoutes,
  entitlements,
  instruments,
  profiles,
  tradingAccounts,
  users,
} from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

const TENANT_TABLES = [
  profiles,
  entitlements,
  dataFeedConnections,
  dataRoutes,
  brokerConnections,
  tradingAccounts,
  auditEvents,
] as const;
const TENANT_TABLE_NAMES = [
  'profile',
  'entitlement',
  'data_feed_connection',
  'data_route',
  'broker_connection',
  'trading_account',
  'audit_event',
] as const;

/** Postgres SQLSTATE of an error, whether raised directly or wrapped by Drizzle. */
function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgCode(error)).toBe(code);
}

let t: TestDatabase;
let userA: string;
let userB: string;

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId: userA }, fn);

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('a@example.test');
  userB = await createUser('b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, {
    userId: userB,
    displayName: 'B',
    timezone: 'Europe/London',
  });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('workspace provisioning', () => {
  it('creates profile, entitlement, demo feed with routes, and one default paper account', async () => {
    await asA(async (tx) => {
      expect(await tx.select().from(profiles)).toHaveLength(1);
      expect(await tx.select().from(entitlements)).toMatchObject([{ planCode: 'dev' }]);
      expect(await tx.select().from(dataFeedConnections)).toMatchObject([{ provider: 'demo' }]);
      expect(await tx.select().from(dataRoutes)).toHaveLength(4);
      expect(await tx.select().from(tradingAccounts)).toMatchObject([
        { mode: 'paper', isDefault: true, currency: 'USD' },
      ]);
      expect(await tx.select().from(auditEvents)).toMatchObject([
        { action: 'workspace.provisioned', actorType: 'system' },
      ]);
    });
  });

  it('is idempotent', async () => {
    expect(await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' })).toBe(false);
    await asA(async (tx) => expect(await tx.select().from(tradingAccounts)).toHaveLength(1));
  });
});

describe('tenant isolation (row-level security as tm_app)', () => {
  it('shows a tenant only its own rows in every tenant table', async () => {
    await asA(async (tx) => {
      for (const table of TENANT_TABLES) {
        const rows = await tx.select({ userId: table.userId }).from(table);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.userId === userA)).toBe(true);
      }
    });
  });

  it('shows nothing when no tenant is set', async () => {
    for (const name of TENANT_TABLE_NAMES) {
      const [row] = await t.appSql.unsafe(`select count(*)::int as n from "${name}"`);
      expect(row?.n, name).toBe(0);
    }
  });

  it('does not leak the tenant setting to the next use of a pooled connection', async () => {
    await asA(async () => undefined);
    const [row] = await t.appSql`select app_current_user_id() as id`;
    expect(row?.id).toBeNull();
  });

  it('rejects writing a row for another tenant', async () => {
    await expectPgError(
      asA((tx) =>
        tx.insert(dataFeedConnections).values({
          userId: userB,
          name: 'sneaky',
          provider: 'demo',
          assetClasses: ['stock'],
        }),
      ),
      '42501',
    );
  });

  it("cannot update or delete another tenant's rows", async () => {
    await asA(async (tx) => {
      const updated = await tx
        .update(profiles)
        .set({ displayName: 'hijacked' })
        .where(eq(profiles.userId, userB))
        .returning();
      expect(updated).toHaveLength(0);
      const deleted = await tx
        .delete(tradingAccounts)
        .where(eq(tradingAccounts.userId, userB))
        .returning();
      expect(deleted).toHaveLength(0);
    });
    await withTenant(t.app.db, { userId: userB }, async (tx) => {
      expect(await tx.select().from(profiles)).toMatchObject([{ displayName: 'B' }]);
      expect(await tx.select().from(tradingAccounts)).toHaveLength(1);
    });
  });

  it("rejects a route that points at another tenant's feed", async () => {
    const [feedB] = await t.ownerSql`select id from data_feed_connection where user_id = ${userB}`;
    await expectPgError(
      asA((tx) =>
        tx.insert(dataRoutes).values({
          userId: userA,
          assetClass: 'stock',
          venue: 'OTHER',
          dataType: 'trades',
          primaryFeedId: feedB?.id as string,
        }),
      ),
      '23503',
    );
  });

  it('lets the app read only its own user record', async () => {
    await asA(async (tx) => {
      expect(await tx.select({ id: users.id }).from(users)).toEqual([{ id: userA }]);
    });
  });

  it('rejects a tenant id that is not a UUID', async () => {
    await expect(withTenant(t.app.db, { userId: "x' or '1'='1" }, async () => 1)).rejects.toThrow(
      TypeError,
    );
  });
});

describe('role boundaries', () => {
  it('gives the app read-only access to reference instruments', async () => {
    await asA(async (tx) => {
      expect(await tx.select().from(instruments)).toHaveLength(DEMO_INSTRUMENTS.length);
    });
    await expectPgError(
      asA((tx) =>
        tx
          .update(instruments)
          .set({ displayName: 'x' })
          .where(sql`true`),
      ),
      '42501',
    );
  });

  it('keeps the auth role out of tenant data', async () => {
    await expectPgError(t.auth.db.select().from(profiles), '42501');
    await expectPgError(t.auth.db.select().from(tradingAccounts), '42501');
  });

  it('keeps sessions, password hashes and verification tokens away from the app', async () => {
    for (const table of ['session', 'account', 'verification', 'rate_limit']) {
      await expectPgError(t.appSql.unsafe(`select * from "${table}"`), '42501');
    }
  });

  it('does not let the app change limits on its entitlement', async () => {
    await expectPgError(
      asA((tx) => tx.update(entitlements).set({ planCode: 'pro' })),
      '42501',
    );
  });
});

describe('paper-only constraints', () => {
  it('rejects a live trading account', async () => {
    await expectPgError(
      asA(async (tx) => {
        const [broker] = await tx.select().from(brokerConnections);
        await tx.insert(tradingAccounts).values({
          userId: userA,
          brokerConnectionId: broker!.id,
          nickname: 'live',
          maskedExternalId: 'X',
          mode: 'live',
          currency: 'USD',
          capabilities: {},
        });
      }),
      '23514',
    );
  });

  it('rejects a live broker connection', async () => {
    await expectPgError(
      asA((tx) =>
        tx.insert(brokerConnections).values({
          userId: userA,
          name: 'live',
          provider: 'demo',
          environment: 'live',
        }),
      ),
      '23514',
    );
  });

  it('allows only one default account per user', async () => {
    await expectPgError(
      asA(async (tx) => {
        const [broker] = await tx.select().from(brokerConnections);
        await tx.insert(tradingAccounts).values({
          userId: userA,
          brokerConnectionId: broker!.id,
          nickname: 'second',
          maskedExternalId: 'DEMO-2',
          currency: 'USD',
          capabilities: {},
          isDefault: true,
        });
      }),
      '23505',
    );
  });
});

describe('audit log', () => {
  it('lets the app append to its own trail but never change it', async () => {
    await asA((tx) =>
      tx.insert(auditEvents).values({
        userId: userA,
        actorType: 'user',
        action: 'test.appended',
        resourceType: 'test',
      }),
    );
    await expectPgError(
      asA((tx) => tx.update(auditEvents).set({ action: 'tampered' })),
      '42501',
    );
    await expectPgError(
      asA((tx) => tx.delete(auditEvents)),
      '42501',
    );
  });

  it('rejects updates and deletes even from the owner', async () => {
    await expectPgError(t.ownerSql`update audit_event set action = 'tampered'`, '42501');
    await expectPgError(t.ownerSql`delete from audit_event`, '42501');
    await expectPgError(t.ownerSql`truncate audit_event`, '42501');
  });
});

describe('account deletion', () => {
  it('removes tenant rows but keeps the audit trail', async () => {
    const userC = await createUser('c@example.test');
    await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
    await t.auth.db.delete(users).where(eq(users.id, userC));

    const [counts] = await t.ownerSql`
      select
        (select count(*)::int from profile where user_id = ${userC}) as profiles,
        (select count(*)::int from trading_account where user_id = ${userC}) as accounts,
        (select count(*)::int from data_route where user_id = ${userC}) as routes,
        (select count(*)::int from audit_event where user_id = ${userC}) as audits`;
    expect(counts).toEqual({ profiles: 0, accounts: 0, routes: 0, audits: 1 });
  });
});

describe('timestamps', () => {
  it('maintains updated_at on update', async () => {
    const before = await asA(async (tx) => (await tx.select().from(profiles))[0]);
    // now() is fixed per transaction, so the update runs in a later one.
    await asA((tx) =>
      tx.update(profiles).set({ locale: 'en-GB' }).where(eq(profiles.userId, userA)),
    );
    const after = await asA(async (tx) => (await tx.select().from(profiles))[0]);
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });
});
