import { buildLedger, createDefinition, type LedgerFill, type Mark } from '@tm/domain';
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { provisionWorkspace } from '../src/provision';
import {
  accountValuations,
  bookValuations,
  instruments,
  notifications,
  positionSnapshots,
  strategyRuntimes,
  tradingAccounts,
  users,
} from '../src/schema';
import { createStrategy, pinDraftVersion } from '../src/strategies';
import { withTenant } from '../src/tenant';
import {
  claimValuations,
  listAccountValuations,
  loadAccountToValue,
  recordValuation,
} from '../src/valuations';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;
let accountA: string;
let accountB: string;
let runtimeA: string;
let runtimeB: string;
let demoA: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const d = (v: string | number) => new Decimal(v);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

async function runtimeFor(userId: string): Promise<string> {
  return as(userId, async (tx) => {
    const s = await createStrategy(tx, userId, { name: 'Valued', definition: createDefinition() });
    const { versionId } = await pinDraftVersion(tx, userId, s.id);
    const [runtime] = await tx
      .insert(strategyRuntimes)
      .values({ userId, strategyId: s.id, versionId, startedBy: userId })
      .returning();
    return runtime!.id;
  });
}

let n = 0;
const fill = (
  runtimeId: string,
  accountId: string,
  p: Pick<LedgerFill, 'direction' | 'quantity' | 'price'>,
): LedgerFill => ({
  id: `f${++n}`,
  runtimeId,
  accountId,
  instrumentId: demoA,
  cycleId: 'c1',
  legLabel: 'Buy A',
  fee: d(0),
  multiplier: d(1),
  filledAt: new Date(Date.UTC(2026, 9, 6, 14, n)),
  ...p,
});
const mark = (price: number): Map<string, Mark> =>
  new Map([[demoA, { price: d(price), at: new Date('2026-10-06T19:59:00Z'), stale: false }]]);

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('val-a@example.test');
  userB = await createUser('val-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await as(userA, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
  accountB = (await as(userB, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
  // B's account stands in for a real broker's: its starting equity comes from the broker.
  await t.owner.db
    .update(tradingAccounts)
    .set({ startingEquity: null })
    .where(eq(tradingAccounts.id, accountB));
  runtimeA = await runtimeFor(userA);
  runtimeB = await runtimeFor(userB);
});

afterAll(async () => {
  await t?.drop();
});

describe('valuation queue', () => {
  it('claims each account once until its lease lapses', async () => {
    const first = await claimValuations(t.worker.db, {
      leaseSeconds: 60,
      everySeconds: 300,
      limit: 10,
    });
    expect(first.map((c) => c.accountId).sort()).toEqual([accountA, accountB].sort());
    expect(first.find((c) => c.accountId === accountA)?.userId).toBe(userA);
    expect(
      await claimValuations(t.worker.db, { leaseSeconds: 60, everySeconds: 300, limit: 10 }),
    ).toEqual([]);
  });
});

describe('recordValuation', () => {
  const ledgerA = () =>
    buildLedger([fill(runtimeA, accountA, { direction: 'buy', quantity: d(10), price: d(100) })]);

  it('records the demo account from its fixed $100,000 start', async () => {
    const result = await as(userA, async (tx) => {
      const account = (await loadAccountToValue(tx, accountA, '2026-10-06'))!;
      expect(account).toMatchObject({ startingEquity: '100000', finalRecorded: false });
      return recordValuation(tx, {
        userId: userA,
        account,
        session: { date: '2026-10-06', final: false },
        now: new Date('2026-10-06T15:00:00Z'),
        ledger: ledgerA(),
        marks: mark(105),
        broker: { positions: new Map([[demoA, d(10)]]) },
      });
    });
    expect(result.appEquity?.toString()).toBe('100050');
    expect(result.flagged).toBe(false);
    const [book] = await as(userA, (tx) => tx.select().from(bookValuations));
    expect(book).toMatchObject({
      runtimeId: runtimeA,
      quantity: '10',
      costBasis: '1000',
      mark: '105',
      unrealized: '50',
      markStale: false,
    });
    // The claim is released: the account is not due again until the interval passes.
    const [row] = await as(userA, (tx) =>
      tx.select().from(tradingAccounts).where(eq(tradingAccounts.id, accountA)),
    );
    expect(row?.valuationLeaseExpiresAt).toBeNull();
    expect(row?.valuedAt).not.toBeNull();
  });

  it('rewrites the session during it, then keeps the close as final', async () => {
    const value = (price: number, at: string, final: boolean) =>
      as(userA, async (tx) =>
        recordValuation(tx, {
          userId: userA,
          account: (await loadAccountToValue(tx, accountA, '2026-10-06'))!,
          session: { date: '2026-10-06', final },
          now: new Date(at),
          ledger: ledgerA(),
          marks: mark(price),
          broker: { positions: new Map([[demoA, d(10)]]) },
        }),
      );
    await value(102, '2026-10-06T20:05:00Z', true);
    await value(90, '2026-10-06T20:10:00Z', true);

    const history = await as(userA, (tx) => listAccountValuations(tx, accountA));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sessionDate: '2026-10-06',
      final: true,
      appEquity: '100020',
      asOf: '2026-10-06T20:05:00.000Z',
      flagged: false,
    });
    expect(
      await as(userA, async (tx) => (await loadAccountToValue(tx, accountA, '2026-10-06'))!),
    ).toMatchObject({ finalRecorded: true });
    const snaps = await as(userA, (tx) => tx.select().from(positionSnapshots));
    expect(snaps.map((s) => `${s.source}:${s.quantity}`).sort()).toEqual(['app:10', 'broker:10']);

    // Nothing, not even the owner, rewrites a final valuation.
    await expect(
      t.owner.db
        .update(accountValuations)
        .set({ appEquity: '1' })
        .where(eq(accountValuations.accountId, accountA)),
    ).rejects.toMatchObject({ cause: { message: 'a final valuation cannot change' } });
  });

  it("takes a broker account's start from the broker, then flags differences at the close", async () => {
    const ledgerB = () =>
      buildLedger([
        fill(runtimeB, accountB, { direction: 'buy', quantity: d(10), price: d(100) }),
        fill(runtimeB, accountB, { direction: 'sell', quantity: d(5), price: d(110) }),
      ]);
    // Realized +50, the 5 left marked at 100: the app has made $50.
    const first = await as(userB, async (tx) =>
      recordValuation(tx, {
        userId: userB,
        account: (await loadAccountToValue(tx, accountB, '2026-10-06'))!,
        session: { date: '2026-10-06', final: false },
        now: new Date('2026-10-06T15:00:00Z'),
        ledger: ledgerB(),
        marks: mark(100),
        broker: {
          balance: { currency: 'USD', cash: '49550', equity: '50050' },
          positions: new Map([[demoA, d(5)]]),
        },
      }),
    );
    expect(first.difference?.toString()).toBe('0');
    const [account] = await as(userB, (tx) => tx.select().from(tradingAccounts));
    expect(account?.startingEquity).toBe('50000');

    // At the next close the broker holds 7 and reports $60 more than the app works out.
    const close = await as(userB, async (tx) =>
      recordValuation(tx, {
        userId: userB,
        account: (await loadAccountToValue(tx, accountB, '2026-10-07'))!,
        session: { date: '2026-10-07', final: true },
        now: new Date('2026-10-07T20:05:00Z'),
        ledger: ledgerB(),
        marks: mark(100),
        broker: {
          balance: { currency: 'USD', cash: '49410', equity: '50110' },
          positions: new Map([[demoA, d(7)]]),
        },
      }),
    );
    expect(close.flagged).toBe(true);
    expect(close.difference?.toString()).toBe('60');
    expect(close.positionDifferences).toEqual([
      { instrumentId: demoA, symbol: 'DEMO-A', app: '5', broker: '7' },
    ]);
    const [note] = await as(userB, (tx) =>
      tx.select().from(notifications).where(eq(notifications.kind, 'reconciliation_mismatch')),
    );
    expect(note?.title).toBe('Demo paper account differs from the broker at the close');
    expect(note?.body).toContain('Equity: app $50050.00, broker $50110.00 (+$60.00)');
    expect(note?.body).toContain('DEMO-A: app 5, broker 7');
  });

  it('flags a broker holding the app has no instrument for, without failing', async () => {
    // Bought outside the app: the Alpaca adapter reports a stand-in id.
    const result = await as(userB, async (tx) =>
      recordValuation(tx, {
        userId: userB,
        account: (await loadAccountToValue(tx, accountB, '2026-10-09'))!,
        session: { date: '2026-10-09', final: true },
        now: new Date('2026-10-09T20:05:00Z'),
        ledger: buildLedger([
          fill(runtimeB, accountB, { direction: 'buy', quantity: d(10), price: d(100) }),
          fill(runtimeB, accountB, { direction: 'sell', quantity: d(5), price: d(110) }),
        ]),
        marks: mark(100),
        broker: {
          balance: { currency: 'USD', cash: '49550', equity: '50050' },
          positions: new Map([
            [demoA, d(5)],
            ['alpaca:NKE', d(3)],
          ]),
        },
      }),
    );
    expect(result.recorded).toBe(true);
    expect(result.flagged).toBe(true);
    expect(result.positionDifferences).toEqual([
      { instrumentId: 'alpaca:NKE', symbol: 'NKE', app: '0', broker: '3' },
    ]);
    const snapshots = await as(userB, (tx) =>
      tx.select().from(positionSnapshots).where(eq(positionSnapshots.accountId, accountB)),
    );
    expect(snapshots.filter((s) => s.asOf.toISOString() === '2026-10-09T20:05:00.000Z')).toEqual([
      expect.objectContaining({ instrumentId: demoA, source: 'app', quantity: '5' }),
      expect.objectContaining({ instrumentId: demoA, source: 'broker', quantity: '5' }),
    ]);
  });

  it('within a dollar is not a difference', async () => {
    const result = await as(userB, async (tx) =>
      recordValuation(tx, {
        userId: userB,
        account: (await loadAccountToValue(tx, accountB, '2026-10-08'))!,
        session: { date: '2026-10-08', final: true },
        now: new Date('2026-10-08T20:05:00Z'),
        ledger: buildLedger([
          fill(runtimeB, accountB, { direction: 'buy', quantity: d(10), price: d(100) }),
          fill(runtimeB, accountB, { direction: 'sell', quantity: d(5), price: d(110) }),
        ]),
        marks: mark(100),
        broker: {
          balance: { currency: 'USD', cash: '49550', equity: '50051.00' },
          positions: new Map([[demoA, d(5)]]),
        },
      }),
    );
    expect(result.difference?.toString()).toBe('1');
    expect(result.flagged).toBe(false);
  });

  it("keeps each tenant's valuations to itself", async () => {
    const seen = await as(userB, (tx) => tx.select().from(accountValuations));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.userId === userB)).toBe(true);
    expect(await as(userB, (tx) => listAccountValuations(tx, accountA))).toEqual([]);
    const books = await as(userB, (tx) => tx.select().from(bookValuations));
    expect(books.every((r) => r.userId === userB)).toBe(true);
  });
});
