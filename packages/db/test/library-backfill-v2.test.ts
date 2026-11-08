import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  createDefinition,
  isEmptyLibraryV2Value,
  type LibraryV2FieldName,
  type StrategyDefinition,
} from '@tm/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBacktest } from '../src/backtests';
import type { Transaction } from '../src/client';
import {
  getLibraryEntry,
  LibraryError,
  listLibraryEntries,
  registerLibraryEntry,
  updateLibraryEntry,
} from '../src/library';
import { STRATEGY_LIBRARY_SEED } from '../src/library-seed';
import { applyBackfillV2, BACKFILL_NOTE, planBackfillV2 } from '../src/library-backfill-v2';
import { provisionWorkspace } from '../src/provision';
import {
  backtestRuns,
  instruments,
  strategyLibraryEntries as entries,
  tradingAccounts,
  users,
} from '../src/schema';
import { createStrategy, updateStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Library v2 fields (ADR 0055, brief §2 and §3): the brief's worked
 * examples, the backfill's dry run and apply, the filters, and edits.
 */

let t: TestDatabase;
let userA: string;
let demoA: string;
let accountA: string;

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId: userA }, fn);
const entryOf = (number: string) => asA((tx) => getLibraryEntry(tx, userA, number));
const numbers = (opts: Parameters<typeof listLibraryEntries>[1]) =>
  asA(async (tx) => (await listLibraryEntries(tx, opts)).items.map((i) => i.registrationNumber));

function readyDefinition(): StrategyDefinition {
  const def = createDefinition();
  const px = {
    kind: 'market' as const,
    instrumentId: demoA,
    field: 'close' as const,
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    offset: 0,
  };
  def.entry.condition.children = [
    {
      kind: 'comparison',
      id: 'entry',
      operator: 'gt',
      left: { ...px, id: 'p1' },
      right: { kind: 'constant', id: 'k1', value: '100' },
    },
  ];
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'exit',
      operator: 'lt',
      left: { ...px, id: 'p2' },
      right: { kind: 'constant', id: 'k2', value: '95' },
    },
  ];
  const leg = {
    instrumentId: demoA,
    accountId: accountA,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell A', side: 'sell', ...leg }];
  return def;
}

/** A Lab strategy linked to `number`, optionally with a completed back test. */
async function buildAndLink(number: string, name: string, completed: boolean) {
  const s = await asA((tx) => createStrategy(tx, userA, { name }));
  const linked = await asA((tx) =>
    updateStrategy(tx, userA, s.id, {
      rowVersion: s.rowVersion,
      library: { kind: 'entry', registrationNumber: number },
    }),
  );
  await asA((tx) =>
    updateStrategy(tx, userA, s.id, {
      rowVersion: linked.rowVersion,
      definition: readyDefinition(),
    }),
  );
  const run = await asA((tx) =>
    startBacktest(tx, userA, s.id, {
      ...DEFAULT_BACKTEST_INPUTS,
      from: '2024-01-02',
      to: '2024-06-28',
    }),
  );
  if (completed) {
    await t.owner.db
      .update(backtestRuns)
      .set({ status: 'completed', finishedAt: sql`now()` })
      .where(eq(backtestRuns.id, run.id));
  }
}

beforeAll(async () => {
  t = await createTestDatabase();
  const [u] = await t.auth.db
    .insert(users)
    .values({ name: 'fields', email: 'fields@example.test' })
    .returning({ id: users.id });
  userA = u!.id;
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  demoA = (await t.owner.db.select().from(instruments)).find((r) => r.symbol === 'DEMO-A')!.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('Library v2 fields on a fresh library', () => {
  it('seeds every entry with its v2 fields, maturity Researched', async () => {
    const plan = await t.owner.db.transaction((tx) => planBackfillV2(tx));
    expect(plan.problems).toEqual([]);
    expect(plan.missing).toEqual([]);
    expect(plan.entries).toHaveLength(31);
    // Nothing to set: the seed already wrote the table's values.
    expect(plan.entries.flatMap((e) => e.fields).filter((f) => f.action !== 'same')).toEqual([]);
    expect(await numbers({ maturity: 'backtested' })).toEqual([]);
    expect(await numbers({ maturity: 'researched' })).toHaveLength(31);
  });

  it('earnings consensus is needed by S00026-SD alone', async () => {
    expect(await numbers({ dataNeed: 'earnings_consensus' })).toEqual(['S00026-SD']);
  });

  it('filters by direction', async () => {
    const neutral = await numbers({ side: 'market_neutral' });
    expect(neutral).toContain('S00024-SN');
    expect(neutral).not.toContain('S00001-SD');
    expect(await numbers({ side: 'long_only', dataNeed: 'fundamentals' })).toEqual([
      'S00007-SY',
      'S00012-SQ',
    ]);
  });
});

describe('The backfill', () => {
  it('fills an entry whose fields are empty, then derives Back tested from a completed run', async () => {
    // Empty the v2 fields of the three worked examples, as on a library
    // seeded before v2.
    await t.owner.db
      .update(entries)
      .set({
        direction: null,
        parameters: [],
        positionSizing: null,
        stopLoss: null,
        rebalanceSchedule: null,
        keyRisks: null,
        dataNeeds: [],
        universe: null,
      })
      .where(sql`${entries.registrationNumber} in ('S00001-SD', 'S00003-SD', 'S00012-SQ')`);
    await buildAndLink('S00001-SD', 'Trend — SPY SMA200', true);
    await buildAndLink('S00003-SD', 'RSI-2', true);
    await buildAndLink('S00012-SQ', 'Multi-factor', true);
    // Linked but never back tested: stays Researched.
    await buildAndLink('S00005-SD', 'Donchian', false);

    const plan = await t.owner.db.transaction((tx) => planBackfillV2(tx));
    const s1 = plan.entries.find((e) => e.registrationNumber === 'S00001-SD')!;
    expect(s1.fields.filter((f) => f.action === 'set').map((f) => f.field)).toEqual([
      'direction',
      'parameters',
      'positionSizing',
      'stopLoss',
      'rebalanceSchedule',
      'maturity',
      'keyRisks',
      'dataNeeds',
      'universe',
    ]);
    expect(s1.fields.find((f) => f.field === 'keyRisks')?.source).toBe("brief's worked example");
    expect(s1.fields.find((f) => f.field === 'stopLoss')?.unspecified).toBe(true);
    const s5 = plan.entries.find((e) => e.registrationNumber === 'S00005-SD')!;
    expect(s5.fields.find((f) => f.field === 'maturity')).toMatchObject({
      action: 'same',
      value: 'researched',
      source: 'linked Lab strategy has no completed back test',
    });

    const result = await t.owner.db.transaction((tx) => applyBackfillV2(tx));
    expect(result.updated).toBe(3);
    expect(await numbers({ maturity: 'backtested' })).toEqual([
      'S00001-SD',
      'S00003-SD',
      'S00012-SQ',
    ]);
  });

  it('reads the brief’s three worked examples exactly', async () => {
    expect(await entryOf('S00001-SD')).toMatchObject({
      direction: 'long_only',
      parameters: [{ name: 'SMA lookback', value: '200', unit: 'days' }],
      positionSizing: { method: 'unspecified' },
      stopLoss: { method: 'unspecified' },
      rebalanceSchedule: { schedule: 'daily_close' },
      maturity: 'backtested',
      keyRisks:
        'Whipsaw in sideways markets — the rule lags the turn and gives back gains; no stop is specified in the research.',
      dataNeeds: ['daily_bars'],
      universe: { kind: 'single_instrument', detail: 'SPY' },
    });
    expect(await entryOf('S00003-SD')).toMatchObject({
      direction: 'long_only',
      parameters: [
        { name: 'RSI lookback', value: '2', unit: 'bars' },
        { name: 'RSI entry threshold', value: '10' },
        { name: 'Exit SMA lookback', value: '5', unit: 'days' },
      ],
      positionSizing: { method: 'unspecified' },
      stopLoss: { method: 'unspecified' },
      rebalanceSchedule: { schedule: 'daily_close' },
      maturity: 'backtested',
      keyRisks:
        'Mean reversion fails in strong trends — a falling market keeps making new RSI lows while the rule keeps buying; the exit depends on a bounce that may not come.',
      dataNeeds: ['daily_bars'],
      universe: { kind: 'single_instrument', detail: 'SPY' },
    });
    const s12 = await entryOf('S00012-SQ');
    expect(s12).toMatchObject({
      direction: 'long_only',
      parameters: [
        { name: 'P/E ceiling', value: '20' },
        { name: 'Earnings yield floor', value: '0' },
        { name: 'Momentum lookback', value: '12', unit: 'months' },
        { name: 'Momentum skip', value: '1', unit: 'month' },
        { name: 'Top-decile cutoff', value: '10', unit: '%' },
      ],
      positionSizing: { method: 'equal_weight', detail: 'Top-decile picks held in equal weight' },
      stopLoss: { method: 'unspecified' },
      rebalanceSchedule: { schedule: 'quarter_end' },
      maturity: 'backtested',
      keyRisks:
        "Survivorship bias — the backtest uses today's S&P 500 members for the whole period; quality factor omitted (no quality metric in the app).",
      dataNeeds: ['daily_bars', 'fundamentals'],
      universe: { kind: 'index_members', detail: 'S&P 500 (current members; backtest-only)' },
    });
    // No unit key where the example has none.
    expect(s12!.parameters[0]).toEqual({ name: 'P/E ceiling', value: '20' });
    const history = s12!.revisions[0]!;
    expect(history).toMatchObject({ note: BACKFILL_NOTE, editedBy: 'system' });
    expect(history.changedFields).toContain('maturity');
  });

  it('is a no-op the second time', async () => {
    const result = await t.owner.db.transaction((tx) => applyBackfillV2(tx));
    expect(result.updated).toBe(0);
  });

  it('keeps a value someone wrote, and never moves Paper trading back', async () => {
    const e = (await entryOf('S00002-SM'))!;
    await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00002-SM', {
        ...editable(e),
        keyRisks: 'Written by a person.',
        maturity: 'paper_trading',
        changeNote: 'Own risks, and paper trading',
        rowVersion: e.rowVersion,
      }),
    );
    await t.owner.db
      .update(entries)
      .set({ direction: null })
      .where(eq(entries.registrationNumber, 'S00002-SM'));
    const plan = await t.owner.db.transaction((tx) => planBackfillV2(tx));
    const s2 = plan.entries.find((x) => x.registrationNumber === 'S00002-SM')!;
    const action = (f: string) => s2.fields.find((x) => x.field === f)?.action;
    expect(action('keyRisks')).toBe('kept');
    expect(action('maturity')).toBe('kept');
    expect(action('direction')).toBe('set');
    await t.owner.db.transaction((tx) => applyBackfillV2(tx));
    expect(await entryOf('S00002-SM')).toMatchObject({
      keyRisks: 'Written by a person.',
      maturity: 'paper_trading',
      direction: 'long_only',
    });
  });
});

/** An entry's editable fields, as the edit form sends them. */
function editable(e: NonNullable<Awaited<ReturnType<typeof entryOf>>>) {
  return {
    name: e.name,
    category: e.category,
    tags: e.tags,
    shortDescription: e.shortDescription,
    longDescription: e.longDescription,
    assets: e.assets,
    dataRequirements: e.dataRequirements ?? undefined,
    entry: e.entry,
    exit: e.exit,
    frequency: e.frequency,
    turnaround: e.turnaround,
    usedBy: e.usedBy,
    trackRecord: e.trackRecord ?? undefined,
    backtestSummary: e.backtestSummary ?? undefined,
    sources: e.sources,
    relatedEntries: e.relatedEntries.map((r) => r.registrationNumber),
    builtStrategyId: e.builtStrategyId,
    direction: e.direction,
    parameters: e.parameters,
    positionSizing: e.positionSizing,
    stopLoss: e.stopLoss,
    rebalanceSchedule: e.rebalanceSchedule,
    maturity: e.maturity,
    keyRisks: e.keyRisks ?? undefined,
    dataNeeds: e.dataNeeds,
    universe: e.universe,
  };
}

describe('Editing a v2 field', () => {
  it('writes history naming the field and leaves number, version and link alone', async () => {
    const e = (await entryOf('S00026-SD'))!;
    const saved = await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00026-SD', {
        ...editable(e),
        stopLoss: { method: 'time_stop', detail: 'Out after 60 trading days' },
        changeNote: 'Name the time stop',
        rowVersion: e.rowVersion,
      }),
    );
    expect(saved.changedFields).toEqual(['stopLoss']);
    const after = (await entryOf('S00026-SD'))!;
    expect(after).toMatchObject({
      registrationNumber: 'S00026-SD',
      conventionVersion: 'v2',
      builtStrategyId: e.builtStrategyId,
      stopLoss: { method: 'time_stop', detail: 'Out after 60 trading days' },
    });
    expect(after.revisions[0]).toMatchObject({
      note: 'Name the time stop',
      changedFields: ['stopLoss'],
    });
  });

  it('keeps the v2 fields when an older client sends none of them', async () => {
    const e = (await entryOf('S00004-SD'))!;
    const {
      direction,
      parameters,
      positionSizing,
      stopLoss,
      rebalanceSchedule,
      maturity,
      keyRisks,
      dataNeeds,
      universe,
      ...older
    } = editable(e);
    void [
      direction,
      parameters,
      positionSizing,
      stopLoss,
      rebalanceSchedule,
      maturity,
      keyRisks,
      dataNeeds,
      universe,
    ];
    const saved = await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00004-SD', {
        ...older,
        name: 'Pairs trading — PEP vs KO (renamed)',
        changeNote: 'Rename',
        rowVersion: e.rowVersion,
      }),
    );
    expect(saved.changedFields).toEqual(['name']);
    expect(await entryOf('S00004-SD')).toMatchObject({
      direction: 'long_short',
      universe: { kind: 'list', detail: 'PEP and KO' },
    });
  });

  it('refuses a save that would clear parameters the form did not load', async () => {
    const e = (await entryOf('S00005-SD'))!;
    expect(e.parameters).toEqual([
      { name: 'Entry channel', value: '20', unit: 'days' },
      { name: 'Exit channel', value: '10', unit: 'days' },
    ]);
    const refused = await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00005-SD', {
        ...editable(e),
        parameters: [],
        longDescription: `${e.longDescription} More.`,
        changeNote: 'Unrelated edit from a form that lost its parameters',
        rowVersion: e.rowVersion,
      }),
    ).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(LibraryError);
    expect(refused).toMatchObject({
      code: 'conflict',
      details: { reason: 'unloaded_fields', fields: ['parameters'] },
      issues: [{ path: ['parameters'] }],
    });
    expect((refused as LibraryError).message).toMatch(/Parameters did not load/);
    // Nothing was written.
    const after = (await entryOf('S00005-SD'))!;
    expect(after.parameters).toEqual(e.parameters);
    expect(after.rowVersion).toBe(e.rowVersion);
    expect(after.longDescription).toBe(e.longDescription);
  });

  it('refuses to empty any other stored profile field unless it is named as cleared', async () => {
    const e = (await entryOf('S00004-SD'))!;
    const emptied = {
      direction: null,
      positionSizing: null,
      stopLoss: null,
      rebalanceSchedule: null,
      universe: null,
      keyRisks: '',
      dataNeeds: [],
      maturity: 'researched' as const,
    };
    const stored = (Object.keys(emptied) as LibraryV2FieldName[]).filter(
      (f) => !isEmptyLibraryV2Value(f, (e as unknown as Record<string, unknown>)[f]),
    );
    expect(stored.length).toBeGreaterThan(0);
    const refused = await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00004-SD', {
        ...editable(e),
        ...emptied,
        changeNote: 'Lost fields',
        rowVersion: e.rowVersion,
      }),
    ).then(
      () => null,
      (err: unknown) => err as LibraryError,
    );
    expect(refused?.code).toBe('conflict');
    expect([...(refused?.details as { fields: string[] }).fields].sort()).toEqual(stored.sort());
  });

  it('clears parameters when the editor removed them on purpose', async () => {
    const e = (await entryOf('S00006-SD'))!;
    expect(e.parameters.length).toBeGreaterThan(0);
    const saved = await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00006-SD', {
        ...editable(e),
        parameters: [],
        clearedFields: ['parameters'],
        changeNote: 'Remove the parameters',
        rowVersion: e.rowVersion,
      }),
    );
    expect(saved.changedFields).toEqual(['parameters']);
    expect((await entryOf('S00006-SD'))!.parameters).toEqual([]);
  });

  it('an unrelated edit keeps the parameters and does not list them as changed', async () => {
    const e = (await entryOf('S00005-SD'))!;
    const saved = await asA((tx) =>
      updateLibraryEntry(tx, userA, 'S00005-SD', {
        ...editable(e),
        longDescription: `${e.longDescription} More.`,
        changeNote: 'Longer description',
        rowVersion: e.rowVersion,
      }),
    );
    expect(saved.changedFields).toEqual(['longDescription']);
    expect((await entryOf('S00005-SD'))!.parameters).toEqual(e.parameters);
  });

  it('refuses an eleventh parameter and an unknown data need', async () => {
    const e = (await entryOf('S00004-SD'))!;
    const tooMany = Array.from({ length: 11 }, (_, i) => ({ name: `p${i}`, value: '1' }));
    await expect(
      asA((tx) =>
        updateLibraryEntry(tx, userA, 'S00004-SD', {
          ...editable(e),
          parameters: tooMany,
          changeNote: 'Too many',
          rowVersion: e.rowVersion,
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      asA((tx) =>
        updateLibraryEntry(tx, userA, 'S00004-SD', {
          ...editable(e),
          dataNeeds: ['tea_leaves'] as never,
          changeNote: 'Unknown',
          rowVersion: e.rowVersion,
        }),
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('Seed entries registered by hand', () => {
  it('are matched by number and name when they have no seed key', async () => {
    const t2 = await createTestDatabase({ seedLibrary: false });
    try {
      await t2.owner.db.transaction(async (tx) => {
        for (const s of STRATEGY_LIBRARY_SEED) await registerLibraryEntry(tx, null, s.input);
      });
      const plan = await t2.owner.db.transaction((tx) => planBackfillV2(tx));
      expect(plan.missing).toEqual([]);
      expect(plan.skipped).toEqual([]);
      expect(plan.entries).toHaveLength(31);
      const pead = plan.entries.find((e) => e.registrationNumber === 'SDS-0026')!;
      expect(pead.seedKey).toBe('seed-26-pead');
      expect(pead.notes[0]).toMatch(/by number and name/);
      expect(pead.fields.find((f) => f.field === 'dataNeeds')).toMatchObject({
        action: 'set',
        value: ['daily_bars', 'earnings_consensus'],
      });
    } finally {
      await t2.drop();
    }
  }, 60_000);
});
