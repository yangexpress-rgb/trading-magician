import { LIBRARY_V2_RENUMBER_TABLE, type RegisterLibraryEntryInput } from '@tm/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  getLibraryEntry,
  LibraryError,
  listLibraryEntries,
  previewRegistrationNumber,
  registerLibraryEntry,
  updateLibraryEntry,
} from '../src/library';
import { applyRenumberV2, planRenumberV2 } from '../src/library-renumber';
import { seedStrategyLibrary, STRATEGY_LIBRARY_SEED } from '../src/library-seed';
import { provisionWorkspace } from '../src/provision';
import { users } from '../src/schema';
import { createStrategy, getStrategy, listStrategies, updateStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Strategy Library v2 (ADR 0055): seed extension 2 and the convention v2
 * renumbering, on a library that starts on v1 the way staging and the Mac
 * do. Tests run in order on one database.
 */

let t: TestDatabase;
let userA: string;
let strategyId: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

const pgCode = (e: unknown) =>
  (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;
async function rejects(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

const entry = (over: Partial<RegisterLibraryEntryInput> = {}): RegisterLibraryEntryInput => ({
  name: 'Registered after the seed',
  category: 'trend',
  shortDescription: 'A test entry.',
  longDescription: 'How it works.',
  assets: 'SPY only',
  entry: 'Buy.',
  exit: 'Sell.',
  frequency: { kind: 'every', value: 1, unit: 'months' },
  turnaround: { kind: 'unknown' },
  timeframeCode: 'D',
  assetClassCode: 'S',
  ...over,
});

beforeAll(async () => {
  t = await createTestDatabase({ renumberFreshLibrary: false });
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: 'v2', email: 'lib-v2@example.test' })
    .returning({ id: users.id });
  userA = row!.id;
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('a library on convention v1 (as staging is before the renumber)', () => {
  it('holds the 31 seed entries under their v1 numbers, and the seed check passes', async () => {
    const { items } = await as(userA, (tx) => listLibraryEntries(tx));
    expect(items.map((i) => i.registrationNumber)).toEqual(
      LIBRARY_V2_RENUMBER_TABLE.map((r) => r.old),
    );
    expect(items.every((i) => i.conventionVersion === 'v1')).toBe(true);
    expect(await seedStrategyLibrary(t.owner.db)).toBe('already_seeded');
  });

  it('a Lab strategy links SDS-0001 and a later entry takes SDS-0032', async () => {
    const s = await as(userA, (tx) => createStrategy(tx, userA, { name: 'Trend — SPY SMA200' }));
    strategyId = s.id;
    await as(userA, (tx) =>
      updateStrategy(tx, userA, s.id, {
        rowVersion: 1,
        library: { kind: 'entry', registrationNumber: 'SDS-0001' },
      }),
    );
    const later = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ relatedEntries: ['SDS-0001', 'SNS-0019'] })),
    );
    expect(later.registrationNumber).toBe('SDS-0032');
  });
});

describe('the renumber dry run', () => {
  it('maps every entry by its stored codes, matching the brief table, and writes nothing', async () => {
    const plan = await t.owner.db.transaction((tx) => planRenumberV2(tx));
    expect(plan.problems).toEqual([]);
    expect(plan.v2Exists).toBe(false);
    expect(plan.counter).toBe(32);
    expect(plan.nextPreview).toBe('S00033-SD');
    expect(plan.rows.slice(0, 31).map((r) => [r.oldNumber, r.newNumber])).toEqual(
      LIBRARY_V2_RENUMBER_TABLE.map((r) => [r.old, r.new]),
    );
    expect(plan.rows[31]).toMatchObject({
      oldNumber: 'SDS-0032',
      newNumber: 'S00032-SD',
      inTable: false,
      relatedAfter: ['S00001-SD', 'S00019-SN'],
    });
    expect(plan.rows[0]!.builtStrategyName).toBe('Trend — SPY SMA200');
    const [v] = await t.ownerSql`select count(*)::int as n from convention_versions`;
    expect(v!.n).toBe(1);
  });
});

describe('only the renumber migration may change a number', () => {
  it('the app login cannot change a number, its version or former numbers', async () => {
    for (const set of [
      sql`registration_number = 'S00001-SD', convention_version = 'v1'`,
      sql`former_numbers = array['SXX-0001']`,
    ]) {
      const e = await rejects(
        as(userA, (tx) =>
          tx.execute(
            sql`update strategy_library_entries set ${set}, updated_by = ${userA} where registration_number = 'SDS-0001'`,
          ),
        ),
      );
      expect(pgCode(e)).toBe('42501');
    }
  });

  it('the app login cannot run the renumber function', async () => {
    const e = await rejects(
      as(userA, (tx) =>
        tx.execute(
          sql`select strategy_library_renumber((select id from strategy_library_entries limit 1), 'v1')`,
        ),
      ),
    );
    expect(pgCode(e)).toBe('42501');
  });

  it('even the owner cannot edit a number directly, or forge the exemption as the app', async () => {
    const owner = await rejects(
      t.ownerSql`update strategy_library_entries set registration_number = 'S00001-SD' where registration_number = 'SDS-0001'`,
    );
    expect(pgCode(owner)).toBe('42501');
    const forged = await rejects(
      as(userA, async (tx) => {
        await tx.execute(
          sql`select set_config('tm.library_renumber', (select id::text from strategy_library_entries where registration_number = 'SDS-0001'), true)`,
        );
        await tx.execute(
          sql`update strategy_library_entries set former_numbers = former_numbers || array['SXX-0099'], updated_by = ${userA} where registration_number = 'SDS-0001'`,
        );
      }),
    );
    expect(pgCode(forged)).toBe('42501');
  });
});

describe('applying the renumber', () => {
  it('renumbers all 32, keeps old numbers as former numbers, and checks itself', async () => {
    const result = await t.owner.db.transaction((tx) => applyRenumberV2(tx));
    expect(result.renumbered).toBe(32);
    expect(result.verification).toHaveLength(4);
    const { items } = await as(userA, (tx) => listLibraryEntries(tx));
    expect(items.slice(0, 31).map((i) => i.registrationNumber)).toEqual(
      LIBRARY_V2_RENUMBER_TABLE.map((r) => r.new),
    );
    expect(items.every((i) => i.conventionVersion === 'v2')).toBe(true);
    expect(items[0]!.formerNumbers).toEqual(['SDS-0001']);
    const [seq] = await t.ownerSql`select last_issued from strategy_library_sequence`;
    expect(seq!.last_issued).toBe(32);
  });

  it('every old number resolves to the entry now numbered in v2, which says Formerly', async () => {
    for (const row of LIBRARY_V2_RENUMBER_TABLE) {
      const e = await as(userA, (tx) => getLibraryEntry(tx, userA, row.old));
      expect(e?.registrationNumber).toBe(row.new);
      expect(e?.formerNumbers).toEqual([row.old]);
    }
    const e = await as(userA, (tx) => getLibraryEntry(tx, userA, 'sds-0001'));
    expect(e!.revisions[0]).toMatchObject({
      action: 'edit',
      note: 'Renumbered to S00001-SD under convention v2 (formerly SDS-0001)',
      changedFields: ['registrationNumber', 'conventionVersion'],
      editedBy: 'system',
    });
    expect(e!.letters).toMatchObject({ timeframe: { code: 'D' }, assetClass: { code: 'S' } });
  });

  it('rewrites every related list to v2 numbers', async () => {
    const rows =
      await t.ownerSql`select registration_number, related_entries from strategy_library_entries`;
    for (const r of rows) {
      for (const n of r.related_entries as string[]) expect(n).toMatch(/^S\d{5}-[A-Z]{2}$/);
    }
    const later = await as(userA, (tx) => getLibraryEntry(tx, userA, 'S00032-SD'));
    expect(later!.relatedEntries.map((r) => [r.registrationNumber, r.name !== null])).toEqual([
      ['S00001-SD', true],
      ['S00019-SN', true],
    ]);
  });

  it('the Lab shows the v2 number, and its number search finds old and new', async () => {
    const s = await as(userA, (tx) => getStrategy(tx, strategyId));
    expect(s.library?.registrationNumber).toBe('S00001-SD');
    for (const q of ['s00001-sd', 'SDS-0001']) {
      const found = await as(userA, (tx) => listStrategies(tx, { search: q }));
      expect(found.items.map((i) => i.id)).toEqual([strategyId]);
    }
    // Linking by a former number links the entry under its current number.
    const other = await as(userA, (tx) => createStrategy(tx, userA, { name: 'Pairs' }));
    const linked = await as(userA, (tx) =>
      updateStrategy(tx, userA, other.id, {
        rowVersion: 1,
        library: { kind: 'entry', registrationNumber: 'SDS-0004' },
      }),
    );
    expect(linked.library?.registrationNumber).toBe('S00004-SD');
  });

  it('new registrations preview and take the next v2 number; no number consumed or skipped', async () => {
    const preview = await as(userA, (tx) =>
      previewRegistrationNumber(tx, { recordType: 'S', timeframe: 'D', assetClass: 'S' }),
    );
    expect(preview).toEqual({ registrationNumber: 'S00033-SD', conventionVersion: 'v2' });
    const issued = await as(userA, (tx) => registerLibraryEntry(tx, userA, entry()));
    expect(issued.registrationNumber).toBe('S00033-SD');
    const bad = await rejects(
      as(userA, (tx) => registerLibraryEntry(tx, userA, entry({ timeframeCode: 'T' }))),
    );
    expect(bad).toBeInstanceOf(LibraryError);
    expect((bad as LibraryError).message).toMatch(/Timeframe code "T" is not in convention v2/);
  });

  it('a former number typed into Related is saved as the current number', async () => {
    const d = (await as(userA, (tx) => getLibraryEntry(tx, userA, 'S00033-SD')))!;
    await as(userA, (tx) =>
      updateLibraryEntry(tx, userA, 'S00033-SD', {
        name: d.name,
        category: d.category,
        shortDescription: d.shortDescription,
        longDescription: d.longDescription,
        assets: d.assets,
        entry: d.entry,
        exit: d.exit,
        frequency: d.frequency,
        turnaround: d.turnaround,
        relatedEntries: ['sqs-0012', 'S00001-SD'],
        rowVersion: d.rowVersion,
        changeNote: 'Related',
      }),
    );
    const after = await as(userA, (tx) => getLibraryEntry(tx, userA, 'S00033-SD'));
    expect(after!.relatedEntries.map((r) => r.registrationNumber)).toEqual([
      'S00012-SQ',
      'S00001-SD',
    ]);
  });

  it('a former number belongs to one entry only', async () => {
    // With the guard set aside (owner, rolled back), the uniqueness trigger still holds.
    const dup = await rejects(
      t.ownerSql.begin(async (q) => {
        await q`alter table strategy_library_entries disable trigger strategy_library_entries_guard`;
        await q`update strategy_library_entries set former_numbers = array['SDS-0001']
                 where registration_number = 'S00002-SM'`;
      }),
    );
    expect(pgCode(dup)).toBe('23505');
  });

  it('running it again changes nothing, and the seed check still passes', async () => {
    const again = await t.owner.db.transaction((tx) => applyRenumberV2(tx));
    expect(again.renumbered).toBe(0);
    expect(again.rows.every((r) => r.action === 'already_v2')).toBe(true);
    expect(await seedStrategyLibrary(t.owner.db)).toBe('already_seeded');
    expect(STRATEGY_LIBRARY_SEED).toHaveLength(31);
  });
});

describe('seed extension 2 on a library seeded with 18', () => {
  let t2: TestDatabase;
  afterAll(async () => {
    await t2?.drop();
  });

  async function seedFirst18(db: TestDatabase) {
    await db.owner.db.transaction(async (tx) => {
      for (const e of STRATEGY_LIBRARY_SEED.slice(0, 18)) {
        await registerLibraryEntry(tx, null, e.input, { seedKey: e.seedKey });
      }
    });
  }

  it('adds 19–31 under v1 when nothing else was registered', async () => {
    t2 = await createTestDatabase({ seedLibrary: false });
    await seedFirst18(t2);
    expect(await seedStrategyLibrary(t2.owner.db)).toBe('extended');
    const rows = await t2.ownerSql`
      select registration_number, related_entries from strategy_library_entries order by sequence_no`;
    expect(rows.map((r) => r.registration_number)).toEqual(
      LIBRARY_V2_RENUMBER_TABLE.map((r) => r.old),
    );
    // Related lists are stored in the library's current (v1) numbers until the renumber.
    expect(rows[25]!.related_entries).toEqual(['SNS-0025', 'SMS-0014']);
  }, 60_000);

  it('registers nothing if other numbers were issued after the 18', async () => {
    const t3 = await createTestDatabase({ seedLibrary: false });
    try {
      await seedFirst18(t3);
      await t3.owner.db.transaction((tx) =>
        registerLibraryEntry(tx, null, entry({ name: 'Auto-created first' })),
      );
      expect(await seedStrategyLibrary(t3.owner.db)).toBe('extension_blocked');
      const [n] = await t3.ownerSql`select count(*)::int as n from strategy_library_entries`;
      expect(n!.n).toBe(19);
      const plan = await t3.owner.db.transaction((tx) => planRenumberV2(tx));
      expect(plan.problems).toContain(
        "Sequence 19: the library has SDS-0019 → S00019-SD, the brief's table says SNS-0019 → S00019-SN",
      );
      await expect(t3.owner.db.transaction((tx) => applyRenumberV2(tx))).rejects.toThrow(
        /Renumbering refused/,
      );
    } finally {
      await t3.drop();
    }
  }, 60_000);
});
