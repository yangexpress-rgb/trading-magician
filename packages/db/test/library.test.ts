import { formatDuration, type RegisterLibraryEntryInput } from '@tm/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  getLibraryEntry,
  LibraryError,
  listLibraryEntries,
  previewRegistrationNumber,
  registerLibraryEntry,
  retireLibraryEntry,
  updateLibraryEntry,
} from '../src/library';
import { matchSeedLinks, seedStrategyLibrary } from '../src/library-seed';
import { provisionWorkspace } from '../src/provision';
import { users } from '../src/schema';
import { createStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Strategy Library acceptance tests (design §11, A1–A10), against a real
 * database as the app login. Tests run in order: the seed is checked before
 * anything else registers, and the convention change (A1) comes last.
 */

let t: TestDatabase;
let userA: string;
let userB: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

const entry = (over: Partial<RegisterLibraryEntryInput> = {}): RegisterLibraryEntryInput => ({
  name: 'Test entry',
  category: 'trend',
  shortDescription: 'A test entry.',
  longDescription: 'How the test entry works.',
  assets: 'SPY only',
  entry: 'Buy when the close is above the 200-day average.',
  exit: 'Sell when the close is below it.',
  frequency: { kind: 'every', value: 1, unit: 'months' },
  turnaround: { kind: 'every', value: 5, unit: 'days', low: 2, high: 10 },
  timeframeCode: 'D',
  assetClassCode: 'S',
  ...over,
});

async function rejects(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}
const pgCode = (e: unknown) =>
  (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code;

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('lib-a@example.test');
  userB = await createUser('lib-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('seed catalogue', () => {
  // A6: the seed table in design §9, exactly and in order.
  it('lists exactly the 18 seed numbers, in order', async () => {
    const { items } = await as(userA, (tx) => listLibraryEntries(tx));
    expect(items.map((i) => i.registrationNumber)).toEqual([
      'SDS-0001',
      'SMS-0002',
      'SDS-0003',
      'SDS-0004',
      'SDS-0005',
      'SDS-0006',
      'SYS-0007',
      'SME-0008',
      'SMS-0009',
      'SMO-0010',
      'SMO-0011',
      'SQS-0012',
      'SMA-0013',
      'SMS-0014',
      'SDA-0015',
      'SDO-0016',
      'SSA-0017',
      'SMA-0018',
    ]);
    expect(items.every((i) => i.conventionVersion === 'v1' && i.status === 'registered')).toBe(
      true,
    );
  });

  it('seeds once: migrating again leaves the catalogue alone', async () => {
    expect(await seedStrategyLibrary(t.owner.db)).toBe('already_seeded');
    const [row] = await t.ownerSql`select last_issued from strategy_library_sequence`;
    expect(row!.last_issued).toBe(18);
  });

  it('records the unbuilt eight with the reason, and no prior user without a source', async () => {
    const { items } = await as(userA, (tx) => listLibraryEntries(tx));
    const details = await as(userA, (tx) =>
      Promise.all(items.map((i) => getLibraryEntry(tx, userA, i.registrationNumber))),
    );
    for (const d of details) {
      expect(d!.usedBy.every((u) => u.source.length > 0)).toBe(true);
      expect(d!.registeredBy).toBe('seed');
      expect(d!.relatedEntries.every((r) => r.name !== null)).toBe(true);
    }
    const notBuilt = details.filter((d) => d!.dataRequirements?.startsWith('Not built'));
    expect(notBuilt.map((d) => d!.registrationNumber)).toEqual([
      'SMO-0010',
      'SMO-0011',
      'SMA-0013',
      'SMS-0014',
      'SDA-0015',
      'SDO-0016',
      'SSA-0017',
      'SMA-0018',
    ]);
  });

  it('is visible only inside a signed-in session', async () => {
    const rows = await t.app.db.execute(
      sql`select count(*)::int as n from strategy_library_entries`,
    );
    expect((rows as unknown as { n: number }[])[0]!.n).toBe(0);
  });
});

describe('registering', () => {
  // A7.
  it('previews and then issues sequence 0019 with the letters of its own selections', async () => {
    const preview = await as(userA, (tx) =>
      previewRegistrationNumber(tx, { recordType: 'S', timeframe: 'W', assetClass: 'E' }),
    );
    expect(preview).toEqual({ registrationNumber: 'SWE-0019', conventionVersion: 'v1' });
    // The preview reserved nothing: it can be asked again and gives the same.
    const again = await as(userB, (tx) =>
      previewRegistrationNumber(tx, { recordType: 'S', timeframe: 'D', assetClass: 'S' }),
    );
    expect(again.registrationNumber).toBe('SDS-0019');
    const issued = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ timeframeCode: 'W', assetClassCode: 'E' })),
    );
    expect(issued).toMatchObject({ registrationNumber: 'SWE-0019', conventionVersion: 'v1' });
  });

  // A4 and A5.
  it('round-trips durations and renders them with units, range and Unknown', async () => {
    const a = await as(userA, (tx) => registerLibraryEntry(tx, userA, entry()));
    const b = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ turnaround: { kind: 'unknown' } })),
    );
    const [da, db] = await as(userB, (tx) =>
      Promise.all([
        getLibraryEntry(tx, userB, a.registrationNumber),
        getLibraryEntry(tx, userB, b.registrationNumber.toLowerCase()),
      ]),
    );
    expect(da!.frequency).toEqual({ kind: 'every', value: 1, unit: 'months' });
    expect(formatDuration(da!.frequency)).toBe('1 month');
    expect(formatDuration(da!.turnaround)).toBe('5 days (range 2–10 days)');
    expect(db!.turnaround).toEqual({ kind: 'unknown' });
    expect(formatDuration(db!.turnaround)).toBe('Unknown');
    expect(da!.registeredBy).toBe('member');
    expect(da!.letters.timeframe?.meaning).toBe('Days');
  });

  // A2.
  it('never issues the same number twice, even at the same moment', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        as(i % 2 ? userA : userB, (tx) =>
          registerLibraryEntry(tx, i % 2 ? userA : userB, entry({ name: `Race ${i}` })),
        ),
      ),
    );
    const seqs = results.map((r) => Number(r.registrationNumber.slice(4))).sort((x, y) => x - y);
    expect(new Set(seqs).size).toBe(8);
    expect(seqs[7]! - seqs[0]!).toBe(7);
  });

  it('a failed save issues no number', async () => {
    const before = await as(userA, (tx) =>
      previewRegistrationNumber(tx, { recordType: 'S', timeframe: 'D', assetClass: 'S' }),
    );
    await rejects(
      as(userA, async (tx) => {
        await registerLibraryEntry(tx, userA, entry());
        throw new Error('fail after the insert');
      }),
    );
    const after = await as(userA, (tx) => registerLibraryEntry(tx, userA, entry()));
    expect(after.registrationNumber).toBe(before.registrationNumber);
  });

  it('rejects codes the current convention does not define', async () => {
    const e = await rejects(
      as(userA, (tx) => registerLibraryEntry(tx, userA, entry({ timeframeCode: 'T' }))),
    );
    expect(e).toBeInstanceOf(LibraryError);
    expect((e as LibraryError).issues?.[0]?.path).toEqual(['timeframeCode']);
  });

  // A10.
  it('refuses a prior user without a source and shows evidence beside the name', async () => {
    const e = await rejects(
      as(userA, (tx) =>
        registerLibraryEntry(
          tx,
          userA,
          entry({ usedBy: [{ who: 'A fund', what: 'Ran it', evidence: 'anecdote', source: ' ' }] }),
        ),
      ),
    );
    expect((e as LibraryError).code).toBe('bad_request');
    expect((e as LibraryError).issues?.[0]?.path).toEqual(['usedBy', 0, 'source']);
    const ok = await as(userA, (tx) =>
      registerLibraryEntry(
        tx,
        userA,
        entry({
          usedBy: [{ who: 'A fund', what: 'Ran it', evidence: 'fund_filing', source: '13F, 2024' }],
        }),
      ),
    );
    const d = await as(userA, (tx) => getLibraryEntry(tx, userA, ok.registrationNumber));
    expect(d!.usedBy[0]).toMatchObject({ who: 'A fund', evidence: 'fund_filing' });
  });

  it('cannot choose its own number, registrant or seed key', async () => {
    const forged = await as(userA, (tx) =>
      tx.execute(sql`insert into strategy_library_entries
        (registration_number, sequence_no, convention_version, record_type_code, timeframe_code,
         asset_class_code, name, category, short_description, long_description, assets, entry, exit,
         frequency, turnaround, registered_by)
        values ('SDS-0500', 500, 'v1', 'S', 'D', 'S', 'Forged', 'trend', 'x', 'x', 'x', 'x', 'x',
          '{"kind":"every","value":1,"unit":"days"}', '{"kind":"unknown"}', ${userA})
        returning registration_number, sequence_no`),
    );
    const row = (forged as unknown as { registration_number: string; sequence_no: number }[])[0]!;
    expect(row.registration_number).not.toBe('SDS-0500');
    expect(row.sequence_no).toBeLessThan(100);
    const e = await rejects(
      as(userA, (tx) =>
        tx.execute(sql`insert into strategy_library_entries
          (registration_number, sequence_no, convention_version, record_type_code, timeframe_code,
           asset_class_code, name, category, short_description, long_description, assets, entry, exit,
           frequency, turnaround, registered_by)
          values ('', 0, 'v1', 'S', 'D', 'S', 'As B', 'trend', 'x', 'x', 'x', 'x', 'x',
            '{"kind":"every","value":1,"unit":"days"}', '{"kind":"unknown"}', ${userB})`),
      ),
    );
    expect(pgCode(e)).toBe('42501');
  });
});

describe('editing and retiring', () => {
  // A8.
  it('edits keep the number, need a change note and are kept in the history', async () => {
    const { registrationNumber } = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ name: 'To edit' })),
    );
    const d = await as(userB, (tx) => getLibraryEntry(tx, userB, registrationNumber));
    const fields = {
      name: 'Edited name',
      category: d!.category,
      shortDescription: d!.shortDescription,
      longDescription: d!.longDescription,
      assets: d!.assets,
      entry: d!.entry,
      exit: d!.exit,
      frequency: d!.frequency,
      turnaround: { kind: 'unknown' as const },
    };
    const noNote = await rejects(
      as(userB, (tx) =>
        updateLibraryEntry(tx, userB, registrationNumber, { ...fields, rowVersion: 1 } as never),
      ),
    );
    expect((noNote as LibraryError).issues?.[0]?.path).toEqual(['changeNote']);
    const done = await as(userB, (tx) =>
      updateLibraryEntry(tx, userB, registrationNumber, {
        ...fields,
        rowVersion: 1,
        changeNote: 'Clearer name; turnaround not measured yet',
      }),
    );
    expect(done).toEqual({
      registrationNumber,
      rowVersion: 2,
      changedFields: ['name', 'turnaround'],
    });
    const stale = await rejects(
      as(userA, (tx) =>
        updateLibraryEntry(tx, userA, registrationNumber, {
          ...fields,
          name: 'Late',
          rowVersion: 1,
          changeNote: 'Late edit',
        }),
      ),
    );
    expect((stale as LibraryError).code).toBe('conflict');
    const after = await as(userA, (tx) => getLibraryEntry(tx, userA, registrationNumber));
    expect(after).toMatchObject({
      registrationNumber,
      name: 'Edited name',
      registeredBy: 'you',
      updatedBy: 'member',
    });
    expect(after!.revisions).toEqual([
      expect.objectContaining({
        action: 'edit',
        note: 'Clearer name; turnaround not measured yet',
        editedBy: 'member',
      }),
    ]);
  });

  it('retired entries stay listed, badged, with their number, and are never revived', async () => {
    const { registrationNumber } = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ name: 'To retire' })),
    );
    await as(userA, (tx) =>
      retireLibraryEntry(tx, userA, registrationNumber, {
        reason: 'Superseded by a variant',
        rowVersion: 1,
      }),
    );
    const listed = await as(userB, (tx) => listLibraryEntries(tx, { search: registrationNumber }));
    expect(listed.items).toEqual([
      expect.objectContaining({ registrationNumber, status: 'retired' }),
    ]);
    const d = await as(userB, (tx) => getLibraryEntry(tx, userB, registrationNumber));
    expect(d).toMatchObject({ retiredReason: 'Superseded by a variant' });
    expect(d!.revisions[0]).toMatchObject({ action: 'retire', editedBy: 'member' });
    const twice = await rejects(
      as(userA, (tx) =>
        retireLibraryEntry(tx, userA, registrationNumber, { reason: 'Again', rowVersion: 2 }),
      ),
    );
    expect((twice as LibraryError).code).toBe('invalid_state');
    const revive = await rejects(
      as(userA, (tx) =>
        tx.execute(sql`update strategy_library_entries
          set status = 'registered', retired_at = null, retired_reason = null, updated_by = ${userA}
          where registration_number = ${registrationNumber}`),
      ),
    );
    expect(pgCode(revive)).toBe('42501');
  });

  it('numbers are immutable and entries are never deleted', async () => {
    const renumber = await rejects(
      as(userA, (tx) =>
        tx.execute(sql`update strategy_library_entries
          set registration_number = 'SDS-0999', updated_by = ${userA}
          where registration_number = 'SDS-0001'`),
      ),
    );
    expect(pgCode(renumber)).toBe('42501');
    const recode = await rejects(
      as(userA, (tx) =>
        tx.execute(sql`update strategy_library_entries
          set timeframe_code = 'M', registration_number = 'SMS-0001', updated_by = ${userA}
          where registration_number = 'SDS-0001'`),
      ),
    );
    expect(pgCode(recode)).toBe('42501');
    const appDelete = await rejects(
      as(userA, (tx) =>
        tx.execute(
          sql`delete from strategy_library_entries where registration_number = 'SDS-0001'`,
        ),
      ),
    );
    expect(pgCode(appDelete)).toBe('42501');
    const ownerDelete = await rejects(
      t.ownerSql`delete from strategy_library_entries where registration_number = 'SDS-0001'`,
    );
    expect(pgCode(ownerDelete)).toBe('42501');
  });
});

describe('built strategy links', () => {
  it('links a strategy from your own workspace only, and shows others it is built elsewhere', async () => {
    const strategy = await as(userA, (tx) => createStrategy(tx, userA, { name: 'Linked one' }));
    const { registrationNumber } = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ builtStrategyId: strategy.id })),
    );
    const mine = await as(userA, (tx) => getLibraryEntry(tx, userA, registrationNumber));
    expect(mine).toMatchObject({
      builtStatus: 'built',
      builtStrategy: { visibility: 'yours', id: strategy.id, name: 'Linked one' },
    });
    const theirs = await as(userB, (tx) => getLibraryEntry(tx, userB, registrationNumber));
    expect(theirs!.builtStrategy).toEqual({ visibility: 'elsewhere' });

    const stolen = await rejects(
      as(userB, (tx) => registerLibraryEntry(tx, userB, entry({ builtStrategyId: strategy.id }))),
    );
    expect((stolen as LibraryError).issues?.[0]?.path).toEqual(['builtStrategyId']);

    // B edits the entry and keeps A's link as it is.
    const d = theirs!;
    await as(userB, (tx) =>
      updateLibraryEntry(tx, userB, registrationNumber, {
        name: d.name,
        category: d.category,
        tags: ['edited-by-b'],
        shortDescription: d.shortDescription,
        longDescription: d.longDescription,
        assets: d.assets,
        entry: d.entry,
        exit: d.exit,
        frequency: d.frequency,
        turnaround: d.turnaround,
        builtStrategyId: d.builtStrategyId,
        rowVersion: d.rowVersion,
        changeNote: 'Tagged',
      }),
    );
    const kept = await as(userA, (tx) => getLibraryEntry(tx, userA, registrationNumber));
    expect(kept!.builtStrategy).toMatchObject({ visibility: 'yours', id: strategy.id });

    const hijack = await rejects(
      as(userB, (tx) =>
        tx.execute(sql`update strategy_library_entries
          set built_strategy_id = gen_random_uuid(), updated_by = ${userB}
          where registration_number = ${registrationNumber}`),
      ),
    );
    expect(pgCode(hijack)).toBe('42501');
  });
});

describe('finding entries', () => {
  // A9.
  it('finds by number, name, asset class, timeframe, category, built status and free text', async () => {
    const find = (o: Parameters<typeof listLibraryEntries>[1]) =>
      as(userB, async (tx) =>
        (await listLibraryEntries(tx, o)).items.map((i) => i.registrationNumber),
      );
    expect(await find({ search: 'sme-0008' })).toEqual(['SME-0008']);
    expect(await find({ search: 'Donchian' })).toEqual(['SDS-0005']);
    expect(await find({ search: 'needs-deal-events' })).toEqual(['SMS-0014']);
    expect(await find({ search: 'correlation premium' })).toEqual(['SDO-0016']);
    expect(await find({ assetClassCode: 'O' })).toEqual(['SMO-0010', 'SMO-0011', 'SDO-0016']);
    expect(await find({ timeframeCode: 'Q' })).toEqual(['SQS-0012']);
    expect(await find({ timeframeCode: 'M', assetClassCode: 'A' })).toEqual([
      'SMA-0013',
      'SMA-0018',
    ]);
    expect(await find({ category: 'carry' })).toEqual(['SMA-0013']);
    const built = await find({ built: 'built' });
    expect(built).toHaveLength(1);
    expect((await find({ built: 'not_built', search: 'SMO-00' })).length).toBe(2);
    expect(await find({ status: 'retired' })).toHaveLength(1);
    expect(await find({ search: '100%_' })).toEqual([]);
    const byName = await find({ sort: 'name', search: 'SDS-000' });
    expect(byName[0]).toBe('SDS-0005');
  });
});

describe('convention versions', () => {
  // A1: runs last, because it puts a new version in effect.
  it('keeps old numbers under v1 while new registrations use a v2 code', async () => {
    const first = await as(userA, (tx) => registerLibraryEntry(tx, userA, entry()));
    expect(first.conventionVersion).toBe('v1');
    const v1Edit = await rejects(
      t.ownerSql`update convention_versions set tables = '{}' where label = 'v1'`,
    );
    expect(pgCode(v1Edit)).toBe('42501');
    const appInsert = await rejects(
      as(userA, (tx) =>
        tx.execute(
          sql`insert into convention_versions (label, effective_from, tables) values ('v9', current_date, '{}')`,
        ),
      ),
    );
    expect(pgCode(appInsert)).toBe('42501');

    await t.ownerSql`
      insert into convention_versions (label, effective_from, tables)
      select 'v2', (now() at time zone 'utc')::date,
             jsonb_set(
               jsonb_set(tables, '{timeframe}', (tables->'timeframe') || '[{"code":"T","meaning":"Ticks"}]'),
               '{timeframe,3,meaning}', '"Trading days"')
        from convention_versions where label = 'v1'`;

    const second = await as(userA, (tx) =>
      registerLibraryEntry(tx, userA, entry({ timeframeCode: 'T' })),
    );
    expect(second.conventionVersion).toBe('v2');
    expect(second.registrationNumber).toMatch(/^STS-00\d\d$/);
    expect(Number(second.registrationNumber.slice(4))).toBe(
      Number(first.registrationNumber.slice(4)) + 1,
    );
    const [a, seed] = await as(userB, (tx) =>
      Promise.all([
        getLibraryEntry(tx, userB, first.registrationNumber),
        getLibraryEntry(tx, userB, 'SDS-0001'),
      ]),
    );
    expect(a).toMatchObject({
      registrationNumber: first.registrationNumber,
      conventionVersion: 'v1',
    });
    expect(a!.letters.timeframe?.meaning).toBe('Days');
    expect(seed!.letters.timeframe?.meaning).toBe('Days');
    const b = await as(userB, (tx) => getLibraryEntry(tx, userB, second.registrationNumber));
    expect(b!.letters.timeframe?.meaning).toBe('Ticks');
  });
});

describe('linking the built seed entries by name', () => {
  it('matches one-to-one and reports anything unclear', () => {
    const ws = [
      { id: '1', name: 'Trend — SPY SMA200' },
      { id: '2', name: 'Mean Reversion — SPY RSI-2' },
      { id: '3', name: 'Breakout — SPY Donchian 20/10' },
      { id: '4', name: 'Multi-factor value + momentum' },
      { id: '5', name: 'Value — S&P 500 earnings yield' },
      { id: '6', name: 'Dual momentum SPY/EFA/AGG' },
      { id: '7', name: 'Sector rotation top 3' },
      { id: '8', name: 'Pairs PEP KO' },
      { id: '9', name: 'VIX spike buys SPY' },
      { id: '10', name: 'Momentum — S&P 500 top decile' },
    ];
    const byNumber = Object.fromEntries(
      matchSeedLinks(ws).map((m) => [
        m.registrationNumber,
        m.result.kind === 'match' ? m.result.strategyId : m.result.kind,
      ]),
    );
    expect(byNumber).toEqual({
      'SDS-0001': '1',
      'SMS-0002': '10',
      'SDS-0003': '2',
      'SDS-0004': '8',
      'SDS-0005': '3',
      'SDS-0006': '9',
      'SYS-0007': '5',
      'SME-0008': '7',
      'SMS-0009': '6',
      'SQS-0012': '4',
    });
    const unclear = matchSeedLinks([
      { id: 'a', name: 'Sector rotation A' },
      { id: 'b', name: 'Sector rotation B' },
    ]).find((m) => m.registrationNumber === 'SME-0008');
    expect(unclear!.result).toEqual({
      kind: 'ambiguous',
      candidates: ['Sector rotation A', 'Sector rotation B'],
    });
  });
});
