import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { MIGRATIONS_FOLDER } from '../src/migrate';
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
 * starts at S00001, separate from the theory range (ADR 0066). Tests run in
 * order and share one database, so numbers follow on.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let accountA: string;
/** Lab numbers start at S00001, a range of their own (ADR 0066). */
const floor = 0;
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
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('Strategy Lab numbers', () => {
  it('gives a strategy saved with instruments its own S number and its theory a T number', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Trend A', definition: definition(['DEMO-A']) }),
    );
    expect(s.labNumber).toBe(`S${seq(floor + 1)}-SD`);
    expect(s.library?.registrationNumber).toMatch(/^T\d{5}-SD$/);
    // S00001-SD is also a former theory number; the ranges are separate (ADR 0066).
    const theories = await t.ownerSql`
      select 1 from strategy_library_entries where ${s.labNumber} = any(former_numbers)`;
    expect(theories).toHaveLength(1);
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

  it('numbers a new draft at once with provisional letters, settled by the first save with instruments', async () => {
    const draft = await asA((tx) => createStrategy(tx, userA, { name: 'Empty draft' }));
    expect(draft.labNumber).toBe(`S${seq(floor + 3)}-SD`);
    const first = await asA((tx) =>
      updateStrategy(tx, userA, draft.id, {
        rowVersion: draft.rowVersion,
        definition: definition(['DEMO-IDX']),
      }),
    );
    expect(first.labNumber).toBe(`S${seq(floor + 3)}-ED`);
    const later = await asA((tx) =>
      updateStrategy(tx, userA, draft.id, {
        rowVersion: first.rowVersion,
        definition: definition(['DEMO-A']),
      }),
    );
    expect(later.labNumber).toBe(`S${seq(floor + 3)}-ED`);
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

  it('numbers every strategy, test fixtures included', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Fixture lab', definition: definition(['DEMO-A']) }),
    );
    expect(s.labNumber).toBe(`S${seq(floor + 4)}-SD`);
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
    // Provisional letters may change, but the digits never do, and the trigger lays out the number.
    const draft = await asA((tx) => createStrategy(tx, userA, { name: 'Forged' }));
    expect(draft.labNumber).toBe(`S${seq(floor + 5)}-SD`);
    await asA((tx) =>
      tx.update(strategies).set({ labNumber: 'S00001-SD' }).where(eq(strategies.id, draft.id)),
    );
    expect((await asA((tx) => getStrategy(tx, draft.id))).labNumber).toBe(`S${seq(floor + 5)}-SD`);
    await expect(
      asA((tx) =>
        tx.update(strategies).set({ labSequenceNo: 1 }).where(eq(strategies.id, draft.id)),
      ),
    ).rejects.toThrow();
    await expect(
      asA((tx) =>
        tx.update(strategies).set({ labAssetClassCode: 'Z' }).where(eq(strategies.id, draft.id)),
      ),
    ).rejects.toThrow();
  });

  it('never reuses the number of a deleted strategy', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Short-lived', definition: definition(['DEMO-C']) }),
    );
    await asA((tx) => deleteStrategy(tx, userA, s.id, { rowVersion: s.rowVersion }));
    const next = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Next one', definition: definition(['DEMO-C']) }),
    );
    expect(s.labNumber).toBe(`S${seq(floor + 6)}-SD`);
    expect(next.labNumber).toBe(`S${seq(floor + 7)}-SD`);
  });

  it('shares one counter across workspaces', async () => {
    const b = await as(userB, (tx) =>
      createStrategy(tx, userB, { name: 'B trend', definition: definition(['DEMO-D']) }),
    );
    expect(b.labNumber).toBe(`S${seq(floor + 8)}-SD`);
  });

  it('lists the theory a strategy refers to, and none for a theory auto-created from it', async () => {
    const linked = await asA((tx) =>
      createStrategy(tx, userA, {
        name: 'Built from a theory',
        definition: definition(['DEMO-A']),
        library: { kind: 'entry', registrationNumber: 'T00001-SD' },
      }),
    );
    expect(linked.labNumber).toBe(`S${seq(floor + 9)}-SD`);
    const { items } = await asA((tx) => listStrategies(tx, { sort: 'theory', direction: 'asc' }));
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get('Built from a theory')?.theoryNumber).toBe('T00001-SD');
    expect(byName.get('Trend A')?.theoryNumber).toBeNull();
    expect(byName.get('Trend A')?.libraryNumber).toMatch(/^T\d{5}-SD$/);
    expect(items[0]?.name).toBe('Built from a theory');
  });

  it('finds a strategy by its Lab number, in its own workspace only, and searches and sorts by it', async () => {
    const number = `S${seq(floor + 1)}-SD`;
    const id = await asA((tx) => strategyIdByLabNumber(tx, number.toLowerCase()));
    expect(id).not.toBeNull();
    expect(await as(userB, (tx) => strategyIdByLabNumber(tx, number))).toBeNull();
    const found = await asA((tx) => listStrategies(tx, { search: number }));
    // Search also matches a theory's former numbers (ADR 0066): S00001-SD finds the
    // strategy numbered S00001-SD and the one built from T00001-SD (formerly S00001-SD).
    expect(found.items.map((i) => i.id)).toContain(id);
    expect(found.items.map((i) => i.name).sort()).toEqual(['Built from a theory', 'Trend A']);
    const sorted = await asA((tx) => listStrategies(tx, { sort: 'number', direction: 'asc' }));
    const numbers = sorted.items.map((i) => i.labNumber);
    expect(numbers.every(Boolean)).toBe(true);
    expect(numbers).toEqual([...numbers].sort());
  });

  it('numbers strategies that have no number yet on deploy, oldest first', async () => {
    const draft = await asA((tx) => createStrategy(tx, userA, { name: 'Older draft' }));
    // As if saved before this change: rules in place, no number.
    await t.ownerSql.unsafe(`
      alter table strategy disable trigger strategy_lab_number;
      update strategy set lab_number = null, lab_sequence_no = null, lab_timeframe_code = null,
        lab_asset_class_code = null, lab_convention_version = null, lab_numbered_at = null
       where id = '${draft.id}';
      alter table strategy enable trigger strategy_lab_number;`);
    await t.owner.db
      .update(strategies)
      .set({ draftDefinition: definition(['DEMO-A']) })
      .where(eq(strategies.id, draft.id));
    const first = await t.owner.db.transaction((tx) => numberExistingLabStrategies(tx));
    expect(first.numbered).toBe(1);
    expect((await asA((tx) => getStrategy(tx, draft.id))).labNumber).toBe(`S${seq(floor + 11)}-SD`);
    const again = await t.owner.db.transaction((tx) => numberExistingLabStrategies(tx));
    expect(again.numbered).toBe(0);
    const [counter] = await t.ownerSql<{ n: number }[]>`
      select last_issued as n from strategy_lab_sequence`;
    expect(counter!.n).toBe(floor + 11);
  });

  it('migration 0080 renumbers Lab numbers issued above the former theory range from S00001', async () => {
    // As on staging after 0079: numbers issued from S00032.
    await t.ownerSql.unsafe(`
      alter table strategy disable trigger strategy_lab_number;
      update strategy set lab_sequence_no = lab_sequence_no + 31,
        lab_number = strategy_library_compose('sequence-first', 5, 'S',
          lab_timeframe_code, lab_asset_class_code, lab_sequence_no + 31)
       where lab_number is not null;
      alter table strategy enable trigger strategy_lab_number;
      update strategy_lab_sequence set last_issued = last_issued + 31;`);
    const before = await t.ownerSql<{ id: string; n: string }[]>`
      select id, lab_number as n from strategy where lab_number is not null order by lab_sequence_no`;
    expect(before[0]!.n).toBe('S00032-SD');
    const file = readFileSync(join(MIGRATIONS_FOLDER, '0080_lab_numbers_from_one.sql'), 'utf8');
    const renumber = file.slice(file.indexOf('ALTER TABLE "strategy" DISABLE'));
    for (const statement of renumber.split('--> statement-breakpoint')) {
      if (statement.trim()) await t.ownerSql.unsafe(statement);
    }
    const after = await t.ownerSql<{ id: string; n: string }[]>`
      select id, lab_number as n from strategy where lab_number is not null order by lab_sequence_no`;
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.n)).toEqual(before.map((r, i) => `S${seq(i + 1)}-${r.n.slice(-2)}`));
    const next = await asA((tx) =>
      createStrategy(tx, userA, { name: 'After renumber', definition: definition(['DEMO-A']) }),
    );
    expect(next.labNumber).toBe(`S${seq(after.length + 1)}-SD`);
  });
});
