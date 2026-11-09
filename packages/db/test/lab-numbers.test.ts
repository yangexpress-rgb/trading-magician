import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { numberExistingLabStrategies, strategyIdByLabNumber } from '../src/library-lab';
import { provisionWorkspace } from '../src/provision';
import { instruments, strategies, tradingAccounts, users } from '../src/schema';
import {
  createStrategy,
  deleteStrategy,
  getStrategy,
  listStrategies,
  updateStrategy,
} from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Strategy Lab numbers (ADR 0065, N182): each Lab strategy has its own S
 * number, laid out by the theory rules, from the Lab's own counter, which
 * starts above every theory sequence that ever had an S number. Tests run in
 * order and share one database, so numbers follow on.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let accountA: string;
let floor: number;
const ids: Record<string, string> = {};

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asA = <T>(fn: (tx: Transaction) => Promise<T>) => as(userA, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

function definition(symbols: string[], interval: '1d' | '5m' = '1d'): StrategyDefinition {
  const def = createDefinition();
  const series = {
    instrumentId: ids[symbols[0]!]!,
    field: 'close' as const,
    interval,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'above',
      operator: 'gt',
      left: { kind: 'market', id: 'px', ...series },
      right: { kind: 'indicator', id: 'sma', name: 'SMA', params: { period: 20 }, ...series },
    },
  ];
  const leg = (symbol: string, side: 'buy' | 'sell', n: number) => ({
    id: `${side}-${n}`,
    legLabel: `${side} ${symbol}`,
    side,
    instrumentId: ids[symbol]!,
    accountId: accountA,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  });
  def.entry.orders = symbols.map((s, i) => leg(s, 'buy', i));
  def.exit.orders = symbols.map((s, i) => leg(s, 'sell', i));
  return def;
}

const seq = (n: number) => String(n).padStart(5, '0');

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('labno-a@example.test');
  userB = await createUser('labno-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  for (const r of await t.owner.db.select().from(instruments)) ids[r.symbol] = r.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  const [row] = await t.ownerSql<{ floor: number }[]>`
    select coalesce(max(sequence_no), 0)::int as floor from strategy_library_entries
     where exists (select 1 from unnest(former_numbers) f where f ~ '^S[0-9]')`;
  floor = row!.floor;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('Strategy Lab numbers', () => {
  it('starts above every former S theory number, so no string names both', () => {
    // The seeded library is renumbered to T; its S numbers live on as former numbers.
    expect(floor).toBeGreaterThan(0);
  });

  it('gives a strategy saved with instruments its own S number and its theory a T number', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Trend A', definition: definition(['DEMO-A']) }),
    );
    expect(s.labNumber).toBe(`S${seq(floor + 1)}-SD`);
    expect(s.library?.registrationNumber).toMatch(/^T\d{5}-SD$/);
    const theories = await t.ownerSql`
      select 1 from strategy_library_entries
       where registration_number = ${s.labNumber} or ${s.labNumber} = any(former_numbers)`;
    expect(theories).toHaveLength(0);
  });

  it('takes the letters from the strategy as theories do (ETF, minute bars)', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, {
        name: 'Minute ETF',
        definition: definition(['DEMO-IDX'], '5m'),
      }),
    );
    expect(s.labNumber).toBe(`S${seq(floor + 2)}-EN`);
  });

  it('issues nothing for a draft without instruments, then numbers it on the save that adds them', async () => {
    const draft = await asA((tx) => createStrategy(tx, userA, { name: 'Empty draft' }));
    expect(draft.labNumber).toBeNull();
    const saved = await asA((tx) =>
      updateStrategy(tx, userA, draft.id, {
        rowVersion: draft.rowVersion,
        definition: definition(['DEMO-B']),
      }),
    );
    expect(saved.labNumber).toBe(`S${seq(floor + 3)}-SD`);
  });

  it('keeps the number and its letters when the strategy later trades something else', async () => {
    const [s] = (await asA((tx) => listStrategies(tx, { search: 'Trend A' }))).items;
    const before = await asA((tx) => getStrategy(tx, s!.id));
    const after = await asA((tx) =>
      updateStrategy(tx, userA, s!.id, {
        rowVersion: before.rowVersion,
        definition: definition(['DEMO-IDX', 'DEMO-A']),
      }),
    );
    expect(after.labNumber).toBe(before.labNumber);
  });

  it('never numbers a test fixture', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Fixture lab', definition: definition(['DEMO-A']) }),
    );
    expect(s.labNumber).toBeNull();
  });

  it('refuses any change to an issued number and ignores a number written by the app', async () => {
    const [s] = (await asA((tx) => listStrategies(tx, { search: 'Minute ETF' }))).items;
    await expect(
      asA((tx) =>
        tx.update(strategies).set({ labNumber: 'S99999-SD' }).where(eq(strategies.id, s!.id)),
      ),
    ).rejects.toThrow();
    await expect(
      asA((tx) =>
        tx.update(strategies).set({ labTimeframeCode: 'D' }).where(eq(strategies.id, s!.id)),
      ),
    ).rejects.toThrow();
    const forged = await asA((tx) => createStrategy(tx, userA, { name: 'Forged' }));
    await asA((tx) =>
      tx
        .update(strategies)
        .set({ labNumber: 'S00001-SD', labSequenceNo: 1 })
        .where(eq(strategies.id, forged.id)),
    );
    expect((await asA((tx) => getStrategy(tx, forged.id))).labNumber).toBeNull();
  });

  it('never reuses the number of a deleted strategy', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Short-lived', definition: definition(['DEMO-C']) }),
    );
    await asA((tx) => deleteStrategy(tx, userA, s.id, { rowVersion: s.rowVersion }));
    const next = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Next one', definition: definition(['DEMO-C']) }),
    );
    expect(next.labNumber).toBe(`S${seq(floor + 5)}-SD`);
    expect(s.labNumber).toBe(`S${seq(floor + 4)}-SD`);
  });

  it('shares one counter across workspaces, and a copy gets a new number', async () => {
    const b = await as(userB, (tx) =>
      createStrategy(tx, userB, { name: 'B trend', definition: definition(['DEMO-D']) }),
    );
    expect(b.labNumber).toBe(`S${seq(floor + 6)}-SD`);
  });

  it('finds a strategy by its Lab number, in its own workspace only, and searches and sorts by it', async () => {
    const number = `S${seq(floor + 1)}-SD`;
    const id = await asA((tx) => strategyIdByLabNumber(tx, number.toLowerCase()));
    expect(id).not.toBeNull();
    expect(await as(userB, (tx) => strategyIdByLabNumber(tx, number))).toBeNull();
    const found = await asA((tx) => listStrategies(tx, { search: number }));
    expect(found.items.map((i) => i.id)).toEqual([id]);
    const sorted = await asA((tx) => listStrategies(tx, { sort: 'number', direction: 'asc' }));
    const numbers = sorted.items.map((i) => i.labNumber).filter(Boolean);
    expect(numbers).toEqual([...numbers].sort());
  });

  it('numbers strategies saved before Lab numbers existed, on deploy, oldest first', async () => {
    const draft = await asA((tx) => createStrategy(tx, userA, { name: 'Older draft' }));
    // As if saved with instruments before this change: rules in place, no number.
    await t.owner.db
      .update(strategies)
      .set({ draftDefinition: definition(['DEMO-A']) })
      .where(eq(strategies.id, draft.id));
    const first = await t.owner.db.transaction((tx) => numberExistingLabStrategies(tx));
    expect(first.numbered).toBe(1);
    expect((await asA((tx) => getStrategy(tx, draft.id))).labNumber).toBe(`S${seq(floor + 7)}-SD`);
    const again = await t.owner.db.transaction((tx) => numberExistingLabStrategies(tx));
    expect(again.numbered).toBe(0);
    const [counter] = await t.ownerSql<{ n: number }[]>`
      select last_issued as n from strategy_lab_sequence`;
    expect(counter!.n).toBe(floor + 7);
  });
});
