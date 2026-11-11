import { createDefinition, scheduleFrom, type StrategyDefinition } from '@tm/domain';
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
function monthEnd(def: StrategyDefinition): StrategyDefinition {
  return { ...def, entry: { ...def.entry, schedule: scheduleFrom('monthEnd') } };
}

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

describe('strategies and theories (ADR 0072)', () => {
  const refer = (id: string, rowVersion: number, number: string) =>
    asA((tx) =>
      updateStrategy(tx, userA, id, {
        rowVersion,
        library: { kind: 'entry', registrationNumber: number },
      }),
    );

  it('starts after the 31 seed entries', async () => {
    expect(await nextSeq()).toBe(32);
  });

  it('a saved strategy refers to no theory, and no theory is created for it', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, {
        name: 'SPY/QQQ monthly rotation',
        definition: monthEnd(definition(['DEMO-IDX', 'DEMO-BND'], accountA)),
      }),
    );
    ids.rotation = s.id;
    expect(s.library).toBeNull();
    expect(s.labNumber).toMatch(/^S\d{5}-EM$/);
    const edited = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, name: 'Renamed rotation' }),
    );
    expect(edited.library).toBeNull();
    expect(await nextSeq()).toBe(32);
  });

  it('refers to any theory by number; nothing is issued', async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Trend — SPY SMA200' }));
    ids.trend = s.id;
    const linked = await refer(s.id, s.rowVersion, 'sds-0001');
    expect(linked.library).toEqual({
      entryId: expect.any(String),
      registrationNumber: 'T00001-SD',
      name: expect.any(String),
      status: 'registered',
    });
    const e = await entryOf(userA, 'T00001-SD');
    expect(e).toMatchObject({
      builtStatus: 'built',
      builtStrategy: { visibility: 'yours', id: ids.trend, name: 'Trend — SPY SMA200' },
    });
    expect(e!.revisions[0]?.note).toContain('Linked to the Strategy Lab strategy');
    // Saving instruments later keeps the reference.
    const saved = await asA((tx) =>
      updateStrategy(tx, userA, s.id, {
        rowVersion: linked.rowVersion,
        definition: definition(['DEMO-A']),
      }),
    );
    expect(saved.library?.registrationNumber).toBe('T00001-SD');
    expect(await nextSeq()).toBe(32);
  });

  it('lets many strategies, and copies, refer to one theory (ADR 0071)', async () => {
    const make = (name: string, number: string, userId = userA, account = accountA) =>
      as(userId, (tx) =>
        createStrategy(tx, userId, {
          name,
          definition: definition(['DEMO-A'], account),
          library: { kind: 'entry', registrationNumber: number },
        }),
      );
    const second = await make('Second on T00001', 'T00001-SD');
    const copy = await asA((tx) => duplicateStrategy(tx, userA, second.id));
    expect(copy.library?.registrationNumber).toBe('T00001-SD');
    let shared = (await entryOf(userA, 'T00001-SD'))!;
    expect(shared.builtStrategyId).toBe(ids.trend);
    expect(shared.referringStrategies.map((r) => r.name)).toEqual([
      'Trend — SPY SMA200',
      'Second on T00001',
      'Copy of Second on T00001',
    ]);
    const list = await asA((tx) => listStrategies(tx, { search: 'T00001-SD' }));
    expect(list.items.map((i) => i.theoryNumber)).toEqual(['T00001-SD', 'T00001-SD', 'T00001-SD']);

    // Another member's strategy on the same theory; each sees only their own.
    const theirs = await make('B trend', 'T00003-SD', userB, accountB);
    const mine = await make('A on T00003', 'T00003-SD');
    expect((await entryOf(userA, 'T00003-SD'))!.referringStrategies.map((r) => r.name)).toEqual([
      'A on T00003',
    ]);
    expect((await entryOf(userB, 'T00003-SD'))!.builtStrategy).toMatchObject({
      visibility: 'yours',
      id: theirs.id,
    });

    // The built link moves to a strategy still referring when its strategy leaves.
    const first = await make('First on T00002', 'T00002-SM');
    const next = await make('Next on T00002', 'T00002-SM');
    await asA((tx) => deleteStrategy(tx, userA, first.id, { rowVersion: first.rowVersion }));
    const moved = (await entryOf(userA, 'T00002-SM'))!;
    expect(moved).toMatchObject({ builtStatus: 'built', builtStrategyId: next.id });
    expect(moved.revisions[0]?.note).toContain('still built by “Next on T00002”');
    await asA((tx) => deleteStrategy(tx, userA, next.id, { rowVersion: next.rowVersion }));
    expect((await entryOf(userA, 'T00002-SM'))!.builtStatus).toBe('not_built');

    for (const id of [second.id, copy.id, mine.id]) {
      const row = await asA((tx) => getStrategy(tx, id));
      await asA((tx) => deleteStrategy(tx, userA, id, { rowVersion: row.rowVersion }));
    }
    shared = (await entryOf(userA, 'T00001-SD'))!;
    expect(shared.referringStrategies.map((r) => r.name)).toEqual(['Trend — SPY SMA200']);
    expect(await nextSeq()).toBe(32);
  });

  it('"No theory" stops referring; the theory reads Not built when none is left', async () => {
    const s = await asA((tx) => getStrategy(tx, ids.trend!));
    const none = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, library: { kind: 'none' } }),
    );
    expect(none.library).toBeNull();
    const e = (await entryOf(userA, 'T00001-SD'))!;
    expect(e.builtStatus).toBe('not_built');
    expect(e.revisions[0]?.note).toContain('no longer refers to it');
    expect(await nextSeq()).toBe(32);
  });

  it('refuses a retired theory with a named error', async () => {
    const e = await asA((tx) => getLibraryEntry(tx, userA, 'T00012-SQ'));
    await asA((tx) =>
      retireLibraryEntry(tx, userA, 'T00012-SQ', { reason: 'Test', rowVersion: e!.rowVersion }),
    );
    const s = await asA((tx) => getStrategy(tx, ids.rotation!));
    const retired = await rejects(refer(s.id, s.rowVersion, 'T00012-SQ'));
    expect(retired.message).toContain('T00012-SQ is retired');
    expect((await asA((tx) => getStrategy(tx, s.id))).library).toBeNull();
  });

  it('keeps both sides equal when the link changes from the Library', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Library-side', definition: definition(['DEMO-A']) }),
    );
    // Registering with the strategy as its built link makes the strategy refer to it.
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
    expect(reg.registrationNumber).toBe('T00032-SD');
    expect((await asA((tx) => getStrategy(tx, s.id))).library?.registrationNumber).toBe(
      'T00032-SD',
    );

    // Clearing the link in the Library's edit form: the strategy refers to no theory.
    const d = (await entryOf(userA, 'T00032-SD'))!;
    const edit = (x: typeof d, builtStrategyId: string | null) => ({
      name: x.name,
      category: x.category,
      tags: x.tags,
      shortDescription: x.shortDescription,
      longDescription: x.longDescription,
      assets: x.assets,
      entry: x.entry,
      exit: x.exit,
      frequency: x.frequency,
      turnaround: x.turnaround,
      builtStrategyId,
      rowVersion: x.rowVersion,
      changeNote: 'Unlinked',
    });
    await asA((tx) => updateLibraryEntry(tx, userA, 'T00032-SD', edit(d, null)));
    expect((await asA((tx) => getStrategy(tx, s.id))).library).toBeNull();

    // B can't take over or clear A's link from the Library.
    await refer(s.id, (await asA((tx) => getStrategy(tx, s.id))).rowVersion, 'T00032-SD');
    const a = (await entryOf(userB, 'T00032-SD'))!;
    const takeover = await rejects(
      as(userB, (tx) => updateLibraryEntry(tx, userB, 'T00032-SD', edit(a, null))),
    );
    expect(takeover.message).toBe("T00032-SD is built in another member's Strategy Lab");
  });
});

describe('backfill (brief D9)', () => {
  let userC: string;
  beforeAll(async () => {
    userC = await createUser('lab-c@example.test');
    await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
    // Strategies that refer to no theory yet.
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
    expect(list.items.every((i) => i.theoryNumber === null)).toBe(true);
  });

  it('apply links them by name and numbers nothing else', async () => {
    const seq = await nextSeq();
    await as(userC, (tx) => backfillSeedLinks(tx, userC, { apply: true }));
    const list = await as(userC, (tx) => listStrategies(tx, { sort: 'name', direction: 'asc' }));
    expect(Object.fromEntries(list.items.map((i) => [i.name, i.theoryNumber]))).toEqual({
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
