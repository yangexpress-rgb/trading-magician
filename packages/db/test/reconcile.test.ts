import type { BrokerAdapter, BrokerPosition } from '@tm/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { provisionWorkspace } from '../src/provision';
import { reconcileAccount } from '../src/reconcile';
import { executionIncidents, instruments, tradingAccounts, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userId: string;
let accountId: string;
let demoA: string;

const as = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);

/** A broker that knows no working orders and reports the given holdings. */
const brokerHolding = (positions: BrokerPosition[]) =>
  ({
    orderUpdates: () => Promise.resolve([]),
    positions: () => Promise.resolve(positions),
  }) as unknown as BrokerAdapter;

beforeAll(async () => {
  t = await createTestDatabase();
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: 'rec', email: 'reconcile@example.test' })
    .returning({ id: users.id });
  userId = row!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'R' });
  accountId = (await as((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
});

afterAll(async () => {
  await t?.drop();
});

describe('reconcileAccount', () => {
  it('flags a holding the app has no instrument for, without failing (review H1)', async () => {
    // Bought outside the app: the Alpaca adapter reports a stand-in id.
    const result = await as((tx) =>
      reconcileAccount(
        tx,
        brokerHolding([
          { instrumentId: 'alpaca:NKE', quantity: '3', averageCost: '90' },
          { instrumentId: demoA, quantity: '2', averageCost: '100' },
        ]),
        { userId, accountId, now: new Date('2026-10-09T15:00:00Z') },
      ),
    );
    expect(result.mismatches).toEqual(
      expect.arrayContaining([
        { kind: 'position', instrumentId: 'alpaca:NKE', symbol: 'NKE', app: '0', broker: '3' },
        { kind: 'position', instrumentId: demoA, symbol: 'DEMO-A', app: '0', broker: '2' },
      ]),
    );
    expect(result.incidentId).toBeDefined();
    const [incident] = await as((tx) =>
      tx.select().from(executionIncidents).where(eq(executionIncidents.id, result.incidentId!)),
    );
    expect(incident?.kind).toBe('reconciliation_mismatch');
    expect(incident?.summary).toContain('NKE: app 0, broker 3');
  });

  it('finds nothing when the broker holds nothing the app does not', async () => {
    const result = await as((tx) =>
      reconcileAccount(tx, brokerHolding([]), {
        userId,
        accountId,
        now: new Date('2026-10-09T15:01:00Z'),
      }),
    );
    expect(result).toEqual({ healed: 0, mismatches: [] });
  });
});
