import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  getLibraryEntry,
  LibraryError,
  nextLibrarySequence,
  registerLibraryEntry,
  retireLibraryEntry,
  updateLibraryEntry,
} from '../src/library';
import { backfillSeedLinks } from '../src/library-lab';
import { provisionWorkspace } from '../src/provision';
import { instruments, tradingAccounts, users } from '../src/schema';
import {
  createStrategy,
  deleteStrategy,
  duplicateStrategy,
  getStrategy,
  listStrategies,
  updateStrategy,
} from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Strategy Lab numbering (ADR 0054): the brief's worked examples and
 * acceptance checks, against a real database as the app login. Tests run in
 * order and share one library, so sequence numbers follow on.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let accountA: string;
let accountB: string;
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

async function rejects(promise: Promise<unknown>): Promise<LibraryError> {
  const e = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LibraryError);
  return e as LibraryError;
}

/** Long `symbols` on daily closes above their 200-day SMA; sell below it. */
function definition(
  symbols: string[],
  account = accountA,
  over: Partial<StrategyDefinition> = {},
): StrategyDefinition {
  const def = createDefinition();
  const first = ids[symbols[0]!]!;
  const series = {
    instrumentId: first,
    field: 'close' as const,
    interval: '1d' as const,
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
      right: { kind: 'indicator', id: 'sma', name: 'SMA', params: { period: 200 }, ...series },
    },
  ];
  const leg = (symbol: string, side: 'buy' | 'sell', n: number) => ({
    id: `${side}-${n}`,
    legLabel: `${side} ${symbol}`,
    side,
    instrumentId: ids[symbol]!,
    accountId: account,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  });
  def.entry.orders = symbols.map((s, i) => leg(s, 'buy', i));
  def.exit.orders = symbols.map((s, i) => leg(s, 'sell', i));
  return { ...def, ...over };
}

const nextSeq = () => asA((tx) => nextLibrarySequence(tx));
const entryOf = (userId: string, number: string) =>
  as(userId, (tx) => getLibraryEntry(tx, userId, number));

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('lab-a@example.test');
  userB = await createUser('lab-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  for (const r of await t.owner.db.select().from(instruments)) ids[r.symbol] = r.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
  accountB = (await as(userB, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('Strategy Lab numbering', () => {
  it('starts after the 31 seed entries', async () => {
    expect(await nextSeq()).toBe(32);
  });

  it('issues no number to a draft with no Entry legs', async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Trend — SPY SMA200' }));
    ids.trend = s.id;
    expect(s.library).toBeNull();
    expect(await nextSeq()).toBe(32);
  });

  it('links an entry: the strategy takes its number and no number is consumed', async () => {
    const s = await asA((tx) =>
      updateStrategy(tx, userA, ids.trend!, {
        rowVersion: 1,
        library: { kind: 'entry', registrationNumber: 'sds-0001' },
      }),
    );
    expect(s.library).toMatchObject({ registrationNumber: 'T00001-SD', autoCreated: false });
    const e = await entryOf(userA, 'T00001-SD');
    expect(e).toMatchObject({
      builtStatus: 'built',
      builtStrategy: { visibility: 'yours', id: ids.trend, name: 'Trend — SPY SMA200' },
    });
    expect(e!.revisions[0]?.note).toContain('Linked to the Strategy Lab strategy');
    expect(await nextSeq()).toBe(32);
    // Saving instruments later keeps the link: nothing is auto-created.
    const saved = await asA((tx) =>
      updateStrategy(tx, userA, ids.trend!, {
        rowVersion: s.rowVersion,
        definition: definition(['DEMO-A']),
      }),
    );
    expect(saved.library?.registrationNumber).toBe('T00001-SD');
    expect(await nextSeq()).toBe(32);
  });

  it('auto-creates a record on first save with no link (letters from the strategy)', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, {
        name: 'SPY/QQQ monthly rotation',
        definition: definition(['DEMO-IDX', 'DEMO-BND'], accountA, {
          schedule: { frequency: 'monthEnd' },
        }),
      }),
    );
    ids.rotation = s.id;
    // Both demo instruments are ETFs, and the schedule is monthly: S, M, E.
    expect(s.library).toMatchObject({ registrationNumber: 'T00032-EM', autoCreated: true });
    const e = await entryOf(userA, 'T00032-EM');
    expect(e).toMatchObject({
      name: 'SPY/QQQ monthly rotation',
      status: 'registered',
      builtStatus: 'built',
      tags: ['auto-created'],
      assets: 'DEMO-BND, DEMO-IDX',
      dataRequirements: 'Auto-created from Strategy Lab — complete in the Library.',
      frequency: { kind: 'every', value: 1, unit: 'months' },
      turnaround: { kind: 'unknown' },
      builtStrategy: { visibility: 'yours', id: s.id },
    });
    expect(e!.entry).toBe('DEMO-IDX close > SMA(200) of DEMO-IDX close');
    expect(e!.exit).toBe('No Exit condition yet.');
    expect(e!.revisions.map((r) => r.action)).toEqual(['create']);
    expect(await nextSeq()).toBe(33);
  });

  it('never re-issues a number on edit', async () => {
    const before = await asA((tx) => getStrategy(tx, ids.rotation!));
    const after = await asA((tx) =>
      updateStrategy(tx, userA, ids.rotation!, {
        rowVersion: before.rowVersion,
        name: 'Renamed rotation',
        definition: definition(['DEMO-A']),
      }),
    );
    expect(after.library?.registrationNumber).toBe('T00032-EM');
    expect(await nextSeq()).toBe(33);
  });

  it('re-links from X to Y: X reverts to Not built, Y is Built', async () => {
    const before = await asA((tx) => getStrategy(tx, ids.rotation!));
    const s = await asA((tx) =>
      updateStrategy(tx, userA, ids.rotation!, {
        rowVersion: before.rowVersion,
        library: { kind: 'entry', registrationNumber: 'T00002-SM' },
      }),
    );
    expect(s.library?.registrationNumber).toBe('T00002-SM');
    const x = await entryOf(userA, 'T00032-EM');
    expect(x).toMatchObject({ builtStatus: 'not_built', registrationNumber: 'T00032-EM' });
    expect(x!.revisions[0]?.note).toContain('now uses T00002-SM');
    expect((await entryOf(userA, 'T00002-SM'))!.builtStatus).toBe('built');
    expect(await nextSeq()).toBe(33);
  });

  it('refuses a retired entry with a named error', async () => {
    const other = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Another trend', definition: definition(['DEMO-A']) }),
    );
    ids.other = other.id;
    expect(other.library?.registrationNumber).toBe('T00033-SD');

    const theirs = await as(userB, (tx) =>
      createStrategy(tx, userB, {
        name: 'B trend',
        definition: definition(['DEMO-A'], accountB),
        library: { kind: 'entry', registrationNumber: 'T00003-SD' },
      }),
    );
    expect(theirs.library?.registrationNumber).toBe('T00003-SD');

    const e = await asA((tx) => getLibraryEntry(tx, userA, 'T00012-SQ'));
    await asA((tx) =>
      retireLibraryEntry(tx, userA, 'T00012-SQ', { reason: 'Test', rowVersion: e!.rowVersion }),
    );
    const retired = await rejects(
      asA((tx) =>
        updateStrategy(tx, userA, other.id, {
          rowVersion: other.rowVersion,
          library: { kind: 'entry', registrationNumber: 'T00012-SQ' },
        }),
      ),
    );
    expect(retired.message).toContain('T00012-SQ is retired');
    // A refusal changes nothing.
    const still = await asA((tx) => getStrategy(tx, other.id));
    expect(still.library?.registrationNumber).toBe('T00033-SD');
    expect(await nextSeq()).toBe(34);
  });

  it('lets many strategies refer to one theory (ADR 0069)', async () => {
    const make = (name: string, number: string) =>
      asA((tx) =>
        createStrategy(tx, userA, {
          name,
          definition: definition(['DEMO-A']),
          library: { kind: 'entry', registrationNumber: number },
        }),
      );
    // A second strategy on a theory another strategy already uses.
    const second = await make('Second on T00001', 'T00001-SD');
    expect(second.library).toMatchObject({ registrationNumber: 'T00001-SD', autoCreated: false });
    // A copy refers to the same theory as its source.
    const copy = await asA((tx) => duplicateStrategy(tx, userA, second.id));
    expect(copy.library).toMatchObject({ registrationNumber: 'T00001-SD', autoCreated: false });
    let shared = (await entryOf(userA, 'T00001-SD'))!;
    expect(shared.builtStatus).toBe('built');
    expect(shared.builtStrategyId).toBe(ids.trend);
    expect(shared.referringStrategies.map((r) => r.name)).toEqual([
      'Trend — SPY SMA200',
      'Second on T00001',
      'Copy of Second on T00001',
    ]);
    // A theory another member's strategy uses is open too; each sees only their own.
    const onB = await make('A on B’s theory', 'T00003-SD');
    expect(onB.library?.registrationNumber).toBe('T00003-SD');
    expect((await entryOf(userA, 'T00003-SD'))!.referringStrategies.map((r) => r.name)).toEqual([
      'A on B’s theory',
    ]);
    expect((await entryOf(userB, 'T00003-SD'))!.referringStrategies.map((r) => r.name)).toEqual([
      'B trend',
    ]);
    expect(await nextSeq()).toBe(34);

    // The built link moves to a strategy still referring when its strategy leaves.
    const first = await make('First on T00004', 'T00004-SD');
    const next = await make('Next on T00004', 'T00004-SD');
    expect((await entryOf(userA, 'T00004-SD'))!.builtStrategyId).toBe(first.id);
    await asA((tx) => deleteStrategy(tx, userA, first.id, { rowVersion: first.rowVersion }));
    const moved = (await entryOf(userA, 'T00004-SD'))!;
    expect(moved).toMatchObject({ builtStatus: 'built', builtStrategyId: next.id });
    expect(moved.revisions[0]?.note).toContain('still built by “Next on T00004”');
    await asA((tx) => deleteStrategy(tx, userA, next.id, { rowVersion: next.rowVersion }));
    expect((await entryOf(userA, 'T00004-SD'))!.builtStatus).toBe('not_built');

    for (const id of [second.id, copy.id, onB.id]) {
      const row = await asA((tx) => getStrategy(tx, id));
      await asA((tx) => deleteStrategy(tx, userA, id, { rowVersion: row.rowVersion }));
    }
    shared = (await entryOf(userA, 'T00001-SD'))!;
    expect(shared.builtStrategyId).toBe(ids.trend);
    expect(shared.referringStrategies.map((r) => r.name)).toEqual(['Trend — SPY SMA200']);
    // B's link was never touched.
    expect((await entryOf(userB, 'T00003-SD'))!.builtStrategy).toMatchObject({
      visibility: 'yours',
    });
  });

  it('switches to a new record: the old entry reverts and a fresh number is issued', async () => {
    const before = await asA((tx) => getStrategy(tx, ids.trend!));
    const s = await asA((tx) =>
      updateStrategy(tx, userA, ids.trend!, {
        rowVersion: before.rowVersion,
        library: { kind: 'new' },
      }),
    );
    expect(s.library).toMatchObject({ registrationNumber: 'T00034-SD', autoCreated: true });
    expect((await entryOf(userA, 'T00001-SD'))!.builtStatus).toBe('not_built');
    expect(await nextSeq()).toBe(35);
  });

  it('shows the number in the Strategy Lab list', async () => {
    const list = await asA((tx) => listStrategies(tx, { sort: 'name', direction: 'asc' }));
    expect(Object.fromEntries(list.items.map((i) => [i.name, i.libraryNumber]))).toEqual({
      'Another trend': 'T00033-SD',
      'Renamed rotation': 'T00002-SM',
      'Trend — SPY SMA200': 'T00034-SD',
    });
    const found = await asA((tx) => listStrategies(tx, { search: 't00034-sd' }));
    expect(found.items.map((i) => i.name)).toEqual(['Trend — SPY SMA200']);
  });

  it('deleting a linked strategy reverts its entry; the record and number stay', async () => {
    const s = await asA((tx) => getStrategy(tx, ids.rotation!));
    await asA((tx) => deleteStrategy(tx, userA, s.id, { rowVersion: s.rowVersion }));
    const e = await entryOf(userA, 'T00002-SM');
    expect(e).toMatchObject({ builtStatus: 'not_built', registrationNumber: 'T00002-SM' });
    expect(e!.revisions[0]?.note).toContain('was deleted');
    // The entry is free again for another strategy.
    const o = await asA((tx) => getStrategy(tx, ids.other!));
    const relinked = await asA((tx) =>
      updateStrategy(tx, userA, o.id, {
        rowVersion: o.rowVersion,
        library: { kind: 'entry', registrationNumber: 'T00002-SM' },
      }),
    );
    expect(relinked.library?.registrationNumber).toBe('T00002-SM');
    expect((await entryOf(userA, 'T00033-SD'))!.builtStatus).toBe('not_built');
  });

  it('gives fixtures no number, and a status or archive change is not a save', async () => {
    const f = await asA((tx) =>
      createStrategy(tx, userA, {
        name: 'Fixture 1 — Sector rotation top 3',
        definition: definition(['DEMO-A']),
      }),
    );
    expect(f.library).toBeNull();
    const archived = await asA((tx) =>
      updateStrategy(tx, userA, f.id, { rowVersion: f.rowVersion, archived: true }),
    );
    expect(archived.library).toBeNull();
    expect(await nextSeq()).toBe(35);
    // Renamed out of the fixture prefix, the next save numbers it.
    const renamed = await asA((tx) =>
      updateStrategy(tx, userA, f.id, { rowVersion: archived.rowVersion, name: 'Sector rotation' }),
    );
    expect(renamed.library?.registrationNumber).toBe('T00035-SD');
  });

  it('keeps both sides equal when the link changes from the Library', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Library-side', definition: definition(['DEMO-A']) }),
    );
    expect(s.library?.registrationNumber).toBe('T00036-SD');
    // Registering with the strategy as its built link moves the strategy to the new entry.
    const reg = await asA((tx) =>
      registerLibraryEntry(tx, userA, {
        name: 'Registered by hand',
        category: 'trend',
        shortDescription: 'x',
        longDescription: 'x',
        assets: 'x',
        entry: 'x',
        exit: 'x',
        frequency: { kind: 'every', value: 1, unit: 'days' },
        turnaround: { kind: 'unknown' },
        timeframeCode: 'D',
        assetClassCode: 'S',
        builtStrategyId: s.id,
      }),
    );
    expect(reg.registrationNumber).toBe('T00037-SD');
    expect((await asA((tx) => getStrategy(tx, s.id))).library?.registrationNumber).toBe(
      'T00037-SD',
    );
    expect((await entryOf(userA, 'T00036-SD'))!.builtStatus).toBe('not_built');

    // Clearing the link in the Library's edit form: the strategy has no record until its next save.
    const d = (await entryOf(userA, 'T00037-SD'))!;
    await asA((tx) =>
      updateLibraryEntry(tx, userA, 'T00037-SD', {
        name: d.name,
        category: d.category,
        tags: d.tags,
        shortDescription: d.shortDescription,
        longDescription: d.longDescription,
        assets: d.assets,
        entry: d.entry,
        exit: d.exit,
        frequency: d.frequency,
        turnaround: d.turnaround,
        builtStrategyId: null,
        rowVersion: d.rowVersion,
        changeNote: 'Unlinked',
      }),
    );
    const unlinked = await asA((tx) => getStrategy(tx, s.id));
    expect(unlinked.library).toBeNull();

    // B can't take over or clear A's link from the Library.
    const a = (await entryOf(userB, 'T00034-SD'))!;
    const takeover = await rejects(
      as(userB, (tx) =>
        updateLibraryEntry(tx, userB, 'T00034-SD', {
          name: a.name,
          category: a.category,
          tags: a.tags,
          shortDescription: a.shortDescription,
          longDescription: a.longDescription,
          assets: a.assets,
          entry: a.entry,
          exit: a.exit,
          frequency: a.frequency,
          turnaround: a.turnaround,
          builtStrategyId: null,
          rowVersion: a.rowVersion,
          changeNote: 'Clear',
        }),
      ),
    );
    expect(takeover.message).toBe("T00034-SD is built in another member's Strategy Lab");
  });

  it('copies get a record of their own', async () => {
    const source = await asA((tx) => getStrategy(tx, ids.trend!));
    const copy = await asA((tx) =>
      createStrategy(tx, userA, { name: `Copy of ${source.name}`, definition: source.definition }),
    );
    expect(copy.library?.registrationNumber).toBe('T00038-SD');
  });
});

describe('backfill (brief D9)', () => {
  let userC: string;
  beforeAll(async () => {
    userC = await createUser('lab-c@example.test');
    await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
    // Strategies saved before the numbering existed have no record: drafts without instruments.
    for (const name of [
      'Pairs PEP KO',
      'VIX spike buys SPY',
      'Sector rotation A',
      'Sector rotation B',
      'Multi-factor value + momentum',
      'Fixture 2 — Breakout SPY Donchian 20/10',
    ]) {
      await as(userC, (tx) => createStrategy(tx, userC, { name }));
    }
  });

  it('dry run proposes clear matches only and changes nothing', async () => {
    const rows = await as(userC, (tx) => backfillSeedLinks(tx, userC, { apply: false }));
    const by = Object.fromEntries(rows.map((r) => [r.registrationNumber, r.outcome.kind]));
    expect(by).toMatchObject({
      'T00004-SD': 'would_link',
      'T00006-SD': 'would_link',
      'T00008-EM': 'ambiguous',
      'T00012-SQ': 'retired',
      // The fixture is never matched; T00001-SD is built in A's workspace.
      'T00005-SD': 'none',
      'T00001-SD': 'none',
    });
    const list = await as(userC, (tx) => listStrategies(tx));
    expect(list.items.every((i) => i.libraryNumber === null)).toBe(true);
  });

  it('apply links them by name and numbers nothing else', async () => {
    const seq = await nextSeq();
    await as(userC, (tx) => backfillSeedLinks(tx, userC, { apply: true }));
    const list = await as(userC, (tx) => listStrategies(tx, { sort: 'name', direction: 'asc' }));
    expect(Object.fromEntries(list.items.map((i) => [i.name, i.libraryNumber]))).toEqual({
      'Fixture 2 — Breakout SPY Donchian 20/10': null,
      'Multi-factor value + momentum': null,
      'Pairs PEP KO': 'T00004-SD',
      'Sector rotation A': null,
      'Sector rotation B': null,
      'VIX spike buys SPY': 'T00006-SD',
    });
    expect((await entryOf(userC, 'T00006-SD'))!.builtStatus).toBe('built');
    expect(await nextSeq()).toBe(seq);
    const again = await as(userC, (tx) => backfillSeedLinks(tx, userC, { apply: true }));
    expect(again.find((r) => r.registrationNumber === 'T00006-SD')!.outcome).toEqual({
      kind: 'already_linked',
      strategyName: 'VIX spike buys SPY',
    });
  });
});
