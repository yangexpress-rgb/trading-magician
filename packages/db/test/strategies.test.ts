import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { provisionWorkspace } from '../src/provision';
import { instruments, strategies, strategyVersions, tradingAccounts, users } from '../src/schema';
import {
  createStrategy,
  deleteStrategy,
  duplicateStrategy,
  getStrategy,
  getStrategyVersion,
  listStrategies,
  publishVersion,
  startStrategy,
  stopStrategy,
  StrategyError,
  updateStrategy,
  validateStoredStrategy,
} from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;
let demoA: string;
let demoB: string;
let accountA: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asA = <T>(fn: (tx: Transaction) => Promise<T>) => as(userA, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  return row.id;
}

async function expectStrategyError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected ${code}`).toBeInstanceOf(StrategyError);
  expect((error as StrategyError).code).toBe(code);
  return error as StrategyError;
}

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}
async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgCode(error)).toBe(code);
}

/** Long DEMO-A when its close crosses above its 20-day SMA; sell when it closes below 95. */
function readyDefinition(account = accountA): StrategyDefinition {
  const def = createDefinition();
  const series = {
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
      id: 'entry-cross',
      operator: 'crosses_above',
      left: { kind: 'market', id: 'px', ...series },
      right: { kind: 'indicator', id: 'sma', name: 'SMA', params: { period: 20 }, ...series },
    },
  ];
  def.exit.condition.children = [
    {
      kind: 'comparison',
      id: 'exit-below',
      operator: 'lt',
      left: { kind: 'market', id: 'px2', ...series },
      right: { kind: 'constant', id: 'k', value: '95' },
    },
  ];
  const leg = {
    instrumentId: demoA,
    accountId: account,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    extendedHours: false,
    timing: { mode: 'immediate' as const },
    timingOnly: false,
  };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy A', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell A', side: 'sell', ...leg }];
  return def;
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('a@example.test');
  userB = await createUser('b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  const rows = await t.owner.db.select().from(instruments);
  demoA = rows.find((r) => r.symbol === 'DEMO-A')!.id;
  demoB = rows.find((r) => r.symbol === 'DEMO-B')!.id;
  accountA = (await asA((tx) => tx.select().from(tradingAccounts)))[0]!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('creating and reading', () => {
  it('creates a strategy with the confirmed defaults, the profile zone and the default account', async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Empty', tags: ['demo'] }));
    expect(s).toMatchObject({
      name: 'Empty',
      status: 'created',
      tags: ['demo'],
      timezone: 'America/New_York',
      baseCurrency: 'USD',
      defaultAccountId: accountA,
      currentVersion: null,
      versions: [],
      rowVersion: 1,
    });
    expect(s.definition.risk.maxOrderNotional).toBe('10000');
    expect(s.definitionHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('saves and reloads a definition unchanged', async () => {
    const def = readyDefinition();
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Round trip', definition: def }));
    const loaded = await asA((tx) => getStrategy(tx, s.id));
    expect(loaded.definition).toEqual(def);
  });

  it('rejects a definition that does not match the schema', async () => {
    await expectStrategyError(
      asA((tx) => createStrategy(tx, userA, { name: 'Bad', definition: { schemaVersion: 1 } })),
      'invalid_definition',
    );
  });
});

describe('tenant isolation', () => {
  it("never shows or changes another tenant's strategies", async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Private' }));
    await expectStrategyError(
      as(userB, (tx) => getStrategy(tx, s.id)),
      'not_found',
    );
    await expectStrategyError(
      as(userB, (tx) => updateStrategy(tx, userB, s.id, { rowVersion: 1, name: 'Mine now' })),
      'not_found',
    );
    await expectStrategyError(
      as(userB, (tx) => duplicateStrategy(tx, userB, s.id)),
      'not_found',
    );
    await expectStrategyError(
      as(userB, (tx) => deleteStrategy(tx, userB, s.id, { rowVersion: 1 })),
      'not_found',
    );
    const listB = await as(userB, (tx) => listStrategies(tx));
    expect(listB.items.map((i) => i.id)).not.toContain(s.id);
    expect((await asA((tx) => getStrategy(tx, s.id))).name).toBe('Private');
  });

  it("rejects a strategy that points at another tenant's account", async () => {
    const accountB = (await as(userB, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
    await expectPgError(
      asA((tx) =>
        tx.insert(strategies).values({
          userId: userA,
          name: 'x',
          draftDefinition: {},
          draftSchemaVersion: 1,
          draftHash: 'x',
          baseCurrency: 'USD',
          timezone: 'UTC',
          defaultAccountId: accountB,
        }),
      ),
      '23503',
    );
  });
});

describe('optimistic concurrency', () => {
  it('rejects a save based on an old copy', async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Race' }));
    const first = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: 1, name: 'First' }),
    );
    expect(first.rowVersion).toBe(2);
    await expectStrategyError(
      asA((tx) => updateStrategy(tx, userA, s.id, { rowVersion: 1, name: 'Second' })),
      'conflict',
    );
    expect((await asA((tx) => getStrategy(tx, s.id))).name).toBe('First');
  });
});

describe('versions', () => {
  it('publishes the draft once per distinct definition', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Versions', definition: readyDefinition() }),
    );
    const v1 = await asA((tx) => publishVersion(tx, userA, s.id, { rowVersion: 1 }));
    expect(v1.created).toBe(true);
    expect(v1.strategy.currentVersion?.versionNo).toBe(1);
    expect(v1.strategy.hasUnpublishedChanges).toBe(false);

    const again = await asA((tx) =>
      publishVersion(tx, userA, s.id, { rowVersion: v1.strategy.rowVersion }),
    );
    expect(again.created).toBe(false);

    const def = readyDefinition();
    def.exit.orders[0]!.quantity.value = '5';
    const edited = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: v1.strategy.rowVersion, definition: def }),
    );
    expect(edited.hasUnpublishedChanges).toBe(true);
    expect(edited.currentVersion?.versionNo).toBe(1); // draft edits don't version before activation

    const v2 = await asA((tx) =>
      publishVersion(tx, userA, s.id, { rowVersion: edited.rowVersion }),
    );
    expect(v2.strategy.versions.map((v) => v.versionNo)).toEqual([2, 1]);
    const old = await asA((tx) => getStrategyVersion(tx, s.id, 1));
    expect(old.definition.exit.orders[0]!.quantity.value).toBe('10');
  });

  it('keeps versions immutable for every role', async () => {
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Frozen', definition: readyDefinition() }),
    );
    await asA((tx) => publishVersion(tx, userA, s.id, { rowVersion: 1 }));
    await expectPgError(
      asA((tx) => tx.update(strategyVersions).set({ definitionHash: 'tampered' })),
      '42501',
    );
    await expectPgError(
      asA((tx) => tx.delete(strategyVersions)),
      '42501',
    );
    await expectPgError(
      t.ownerSql`update strategy_version set definition_hash = 'tampered'`,
      '42501',
    );
    await expectPgError(t.ownerSql`delete from strategy_version`, '42501');
    await expectPgError(t.ownerSql`truncate strategy_version cascade`, '42501');
  });

  it('does not let the app hard-delete a strategy', async () => {
    const s = await asA((tx) => createStrategy(tx, userA, { name: 'Sticky' }));
    await expectPgError(
      asA((tx) => tx.delete(strategies).where(eq(strategies.id, s.id))),
      '42501',
    );
  });
});

describe('lifecycle', () => {
  it('moves through Created, Under testing, Actively executing and Off with history', async () => {
    let s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Lifecycle', definition: readyDefinition() }),
    );

    await expectStrategyError(
      asA((tx) => startStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, confirmed: true })),
      'transition_blocked',
    );

    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
    );
    expect(s.status).toBe('under_testing');

    const unconfirmed = await expectStrategyError(
      asA((tx) =>
        startStrategy(tx, userA, s.id, {
          rowVersion: s.rowVersion,
          acknowledgedWarnings: ['no_backtest'],
        }),
      ),
      'transition_blocked',
    );
    expect(unconfirmed.details).toMatchObject({ reason: 'not_confirmed' });

    // Never back tested: a warning to acknowledge on paper (§7.4, §20 #12).
    s = await asA((tx) =>
      startStrategy(tx, userA, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: ['no_backtest'],
      }),
    );
    expect(s).toMatchObject({ status: 'actively_executing', hasBeenActive: true });
    expect(s.currentVersion?.versionNo).toBe(1);

    await expectStrategyError(
      asA((tx) =>
        updateStrategy(tx, userA, s.id, {
          rowVersion: s.rowVersion,
          definition: createDefinition(),
        }),
      ),
      'invalid_state',
    );
    await expectStrategyError(
      asA((tx) => deleteStrategy(tx, userA, s.id, { rowVersion: s.rowVersion })),
      'invalid_state',
    );

    s = await asA((tx) =>
      stopStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, reason: 'test' }),
    );
    expect(s.status).toBe('off');

    // Once it has run, changed rules are a new version straight away.
    const def = readyDefinition();
    def.entry.orders[0]!.quantity.value = '20';
    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, definition: def }),
    );
    expect(s.currentVersion?.versionNo).toBe(2);
    expect(s.hasUnpublishedChanges).toBe(false);

    s = await asA((tx) =>
      startStrategy(tx, userA, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: ['no_backtest'],
      }),
    );
    expect(s.versions).toHaveLength(2); // unchanged draft re-uses the current version
    expect(s.statusHistory.map((h) => `${h.fromStatus}>${h.toStatus}@${h.versionNo}`)).toEqual([
      'off>actively_executing@2',
      'actively_executing>off@1',
      'under_testing>actively_executing@1',
      'created>under_testing@null',
    ]);
  });

  it('blocks activation with validation errors and unacknowledged warnings', async () => {
    let s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Not ready', definition: createDefinition() }),
    );
    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, status: 'under_testing' }),
    );
    const blocked = await expectStrategyError(
      asA((tx) => startStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, confirmed: true })),
      'transition_blocked',
    );
    expect(blocked.details).toMatchObject({ reason: 'validation_errors' });

    // The demo account has no extended-hours session, so that is an error, not a warning.
    const def = readyDefinition();
    def.entry.orders[0]!.extendedHours = true;
    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, definition: def }),
    );
    const unsupported = await expectStrategyError(
      asA((tx) => startStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, confirmed: true })),
      'transition_blocked',
    );
    expect(unsupported.details).toMatchObject({ reason: 'validation_errors' });

    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, definition: readyDefinition() }),
    );
    const warned = await expectStrategyError(
      asA((tx) => startStrategy(tx, userA, s.id, { rowVersion: s.rowVersion, confirmed: true })),
      'transition_blocked',
    );
    expect(warned.details).toMatchObject({
      reason: 'unacknowledged_warnings',
      details: ['no_backtest'],
    });

    s = await asA((tx) =>
      startStrategy(tx, userA, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: ['no_backtest'],
      }),
    );
    expect(s.statusHistory[0]?.acknowledgedWarnings).toEqual(['no_backtest']);
  });

  it('validates with the tenant’s own accounts and feeds', async () => {
    const accountB = (await as(userB, (tx) => tx.select().from(tradingAccounts)))[0]!.id;
    const s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Foreign account', definition: readyDefinition(accountB) }),
    );
    const { validation } = await asA((tx) => validateStoredStrategy(tx, s.id));
    expect(validation.errors.map((e) => e.code)).toEqual(['missing_account', 'missing_account']);
  });
});

describe('library', () => {
  it('searches, filters and sorts', async () => {
    const owner = await createUser('library@example.test');
    await provisionWorkspace(t.app.db, { userId: owner, displayName: 'L' });
    const mk = (name: string, opts: { tags?: string[]; definition?: unknown } = {}) =>
      as(owner, (tx) => createStrategy(tx, owner, { name, ...opts }));

    const alpha = await mk('Alpha pairs', { tags: ['pairs'], definition: readyDefinition() });
    const beta = await mk('beta momentum');
    const gamma = await mk('Gamma breakout', { tags: ['breakout'] });
    await as(owner, (tx) => updateStrategy(tx, owner, gamma.id, { rowVersion: 1, archived: true }));
    const deleted = await mk('Deleted one');
    await as(owner, (tx) => deleteStrategy(tx, owner, deleted.id, { rowVersion: 1 }));
    await as(owner, (tx) =>
      updateStrategy(tx, owner, beta.id, { rowVersion: 1, status: 'under_testing' }),
    );

    const list = (q: Parameters<typeof listStrategies>[1]) =>
      as(owner, (tx) => listStrategies(tx, q)).then((r) => r.items.map((i) => i.name));

    expect(await list({ sort: 'name', direction: 'asc' })).toEqual([
      'Alpha pairs',
      'beta momentum',
    ]);
    expect(await list({ archived: 'only' })).toEqual(['Gamma breakout']);
    expect(await list({ archived: 'include', search: 'BREAK' })).toEqual(['Gamma breakout']);
    expect(await list({ search: 'pairs' })).toEqual(['Alpha pairs']);
    expect(await list({ search: '%' })).toEqual([]);
    expect(await list({ statuses: ['under_testing'] })).toEqual(['beta momentum']);
    expect(await list({ instrumentId: demoA })).toEqual(['Alpha pairs']);
    expect(await list({ instrumentId: demoB })).toEqual([]);
    expect(await list({ updatedFrom: new Date(Date.now() + 60_000) })).toEqual([]);

    const [summary] = (await as(owner, (tx) => listStrategies(tx, { search: 'Alpha' }))).items;
    expect(summary).toMatchObject({
      instruments: [{ id: demoA, symbol: 'DEMO-A' }],
      accountMode: 'paper',
      latestBacktest: null,
      currentVersionNo: null,
    });
    expect(alpha.id).toBe(summary?.id);
  });

  it('duplicates as a new Created strategy without history', async () => {
    let s = await asA((tx) =>
      createStrategy(tx, userA, { name: 'Original', definition: readyDefinition() }),
    );
    s = await asA((tx) =>
      updateStrategy(tx, userA, s.id, { rowVersion: 1, status: 'under_testing' }),
    );
    s = await asA((tx) =>
      startStrategy(tx, userA, s.id, {
        rowVersion: s.rowVersion,
        confirmed: true,
        acknowledgedWarnings: ['no_backtest'],
      }),
    );
    const copy = await asA((tx) => duplicateStrategy(tx, userA, s.id));
    expect(copy).toMatchObject({
      name: 'Copy of Original',
      status: 'created',
      hasBeenActive: false,
      versions: [],
      statusHistory: [],
    });
    expect(copy.definition).toEqual(s.definition);

    const named = await asA((tx) =>
      duplicateStrategy(tx, userA, s.id, { name: 'Original B', description: 'Tighter exits' }),
    );
    expect(named).toMatchObject({
      name: 'Original B',
      description: 'Tighter exits',
      status: 'created',
    });
    expect(named.definition).toEqual(s.definition);
  });
});

describe('account deletion', () => {
  it('removes strategies and their versions with the account', async () => {
    const userC = await createUser('c@example.test');
    await provisionWorkspace(t.app.db, { userId: userC, displayName: 'C' });
    const s = await as(userC, (tx) => createStrategy(tx, userC, { name: 'Gone' }));
    await as(userC, (tx) => publishVersion(tx, userC, s.id, { rowVersion: 1 }));
    await t.auth.db.delete(users).where(eq(users.id, userC));
    const [counts] = await t.ownerSql`
      select
        (select count(*)::int from strategy where user_id = ${userC}) as strategies,
        (select count(*)::int from strategy_version where user_id = ${userC}) as versions,
        (select count(*)::int from audit_event where user_id = ${userC}) as audits`;
    expect(counts).toMatchObject({ strategies: 0, versions: 0 });
    expect(counts?.audits).toBeGreaterThan(0);
  });
});
