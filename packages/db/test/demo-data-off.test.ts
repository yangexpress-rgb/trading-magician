import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDefinition } from '@tm/domain';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { createFeed, IntegrationError } from '../src/feeds';
import { MIGRATIONS_FOLDER } from '../src/migrate';
import { provisionWorkspace } from '../src/provision';
import {
  brokerConnections,
  dataFeedConnections,
  dataRoutes,
  instruments,
  plans,
  tradingAccounts,
  users,
} from '../src/schema';
import { seedReferenceData } from '../src/seed';
import { createStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Migration 0051 and the demo-off defaults (ADR 0039): unused demo data goes,
 * anything a person made on a demo instrument stays.
 */
let t: TestDatabase;
let keeper: string;
let other: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

/** Runs migration 0051 again, as it would run on a database that had demo data. */
async function runDemoOffMigration() {
  const text = readFileSync(join(MIGRATIONS_FOLDER, '0051_demo_data_off.sql'), 'utf8');
  await t.ownerSql.begin(async (sql) => {
    for (const statement of text.split('--> statement-breakpoint')) {
      if (statement.trim()) await sql.unsafe(statement);
    }
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  keeper = await createUser('keeper@example.test');
  other = await createUser('other@example.test');
  await provisionWorkspace(t.app.db, { userId: keeper, displayName: 'Keeper', demo: true });
  await provisionWorkspace(t.app.db, { userId: other, displayName: 'Other', demo: true });
  const demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!;
  const [account] = await as(keeper, (tx) => tx.select().from(tradingAccounts));
  const def = createDefinition();
  def.entry.orders = [
    {
      id: 'buy',
      legLabel: 'Buy A',
      side: 'buy',
      instrumentId: demoA.id,
      accountId: account!.id,
      quantity: { type: 'units', value: '1', rounding: 'down' },
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
      timing: { mode: 'immediate' },
      timingOnly: false,
    },
  ];
  await as(keeper, (tx) => createStrategy(tx, keeper, { name: 'On DEMO-A', definition: def }));
  await runDemoOffMigration();
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('migration 0051', () => {
  it('removes the demo feed and routes of someone who never used them', async () => {
    const feeds = await t.owner.db
      .select()
      .from(dataFeedConnections)
      .where(eq(dataFeedConnections.userId, other));
    expect(feeds).toEqual([]);
    const routes = await t.owner.db.select().from(dataRoutes).where(eq(dataRoutes.userId, other));
    expect(routes).toEqual([]);
  });

  it('keeps the demo feed of someone with a strategy on a demo instrument', async () => {
    const feeds = await t.owner.db
      .select()
      .from(dataFeedConnections)
      .where(eq(dataFeedConnections.userId, keeper));
    expect(feeds.map((f) => f.provider)).toEqual(['demo']);
  });

  it('deletes only the demo instruments nobody uses', async () => {
    const left = await t.owner.db
      .select({ symbol: instruments.symbol })
      .from(instruments)
      .where(eq(instruments.isDemo, true));
    expect(left.map((r) => r.symbol)).toEqual(['DEMO-A']);
  });

  it('lets the built-in paper account trade real US listings', async () => {
    const accounts = await t.owner.db
      .select()
      .from(tradingAccounts)
      .where(inArray(tradingAccounts.userId, [keeper, other]));
    const byUser = new Map(accounts.map((a) => [a.userId, a]));
    expect(byUser.get(other)).toMatchObject({
      nickname: 'Paper account',
      capabilities: expect.objectContaining({ coverage: 'us' }),
    });
    expect(byUser.get(keeper)).toMatchObject({
      nickname: 'Demo paper account',
      capabilities: expect.objectContaining({ coverage: 'demo' }),
    });
    const [broker] = await t.owner.db
      .select()
      .from(brokerConnections)
      .where(eq(brokerConnections.userId, other));
    expect(broker?.name).toBe('Built-in paper broker');
  });

  it('lets the Free plan add its own market data', async () => {
    const [free] = await t.owner.db.select().from(plans).where(eq(plans.code, 'free'));
    expect(free?.limits).toMatchObject({ liveData: true });
  });
});

describe('with demo data off', () => {
  it('seeds nothing', async () => {
    expect(await seedReferenceData(t.owner.db, { demo: false })).toBe(false);
  });

  it('starts a workspace with no feed and a paper account for US listings', async () => {
    const fresh = await createUser('fresh@example.test');
    await provisionWorkspace(t.app.db, { userId: fresh, displayName: 'Fresh', demo: false });
    expect(await as(fresh, (tx) => tx.select().from(dataFeedConnections))).toEqual([]);
    const [account] = await as(fresh, (tx) => tx.select().from(tradingAccounts));
    expect(account).toMatchObject({
      nickname: 'Paper account',
      capabilities: expect.objectContaining({ coverage: 'us' }),
    });
  });

  it('refuses to add a demo feed', async () => {
    const before = process.env.DEMO_DATA;
    process.env.DEMO_DATA = 'off';
    try {
      const error = await as(other, (tx) =>
        createFeed(tx, { userId: other, name: 'Demo', provider: 'demo', assetClasses: ['stock'] }),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IntegrationError);
    } finally {
      process.env.DEMO_DATA = before;
    }
  });
});
