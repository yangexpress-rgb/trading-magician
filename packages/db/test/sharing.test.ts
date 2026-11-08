import { createDefinition, type StrategyDefinition } from '@tm/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setPlatformAdmin } from '../src/admin';
import { prepareAccountDeletion } from '../src/account-deletion';
import type { Transaction } from '../src/client';
import { getLibraryEntry, listLibraryEntries, retireLibraryEntry } from '../src/library';
import { listNotifications, updateNotificationPrefs } from '../src/notifications';
import { provisionWorkspace } from '../src/provision';
import {
  instruments,
  strategies,
  strategyLibraryEntries,
  strategyShares,
  tradingAccounts,
  users,
} from '../src/schema';
import {
  acceptShare,
  createShares,
  declineShare,
  expireShares,
  getShare,
  listShareMembers,
  listShares,
  lookupShareMember,
  NO_ACCOUNT,
  pendingShareCount,
  ShareError,
  withdrawShare,
} from '../src/sharing';
import { createStrategy, getStrategy, listStrategies, updateStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Strategy sharing (ADR 0056) against a real database as the app login: member
 * IDs, the share functions, the copies and their numbers, row-level security.
 * Tests run in order and share one library, so numbers follow on.
 */

let t: TestDatabase;
const u: Record<'admin' | 'a' | 'b' | 'c' | 'gone', string> = {
  admin: '',
  a: '',
  b: '',
  c: '',
  gone: '',
};
const account: Record<string, string> = {};
const ids: Record<string, string> = {};
/** Seed numbers by sequence (their letters vary). */
const num = (seq: number) => ids[`seq${seq}`]!;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string, name: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name, email, memberCode: 'U9999' })
    .returning({ id: users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: name });
  return row!.id;
}

async function refused(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const e = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ShareError);
  expect((e as ShareError).message).toMatch(message);
}

function definition(symbol: string, accountId: string): StrategyDefinition {
  const def = createDefinition();
  const leg = (side: 'buy' | 'sell') => ({
    id: `${side}-0`,
    legLabel: `${side} ${symbol}`,
    side,
    instrumentId: ids[symbol]!,
    accountId,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  });
  def.entry.orders = [leg('buy')];
  def.exit.orders = [leg('sell')];
  return def;
}

const nextNumber = async () =>
  Number(
    (await t.ownerSql`select last_issued from strategy_library_sequence where id = 1`)[0]!
      .last_issued,
  ) + 1;

beforeAll(async () => {
  t = await createTestDatabase();
  u.admin = await createUser('boss@example.test', 'Boss');
  u.a = await createUser('ann@example.test', 'Ann');
  u.b = await createUser('ben@example.test', 'Ben');
  u.c = await createUser('cat@example.test', 'Cat');
  u.gone = await createUser('gone@example.test', 'Gone');
  await setPlatformAdmin(t.owner.db, t.auth.db, 'boss@example.test', true);
  for (const r of await t.owner.db.select().from(instruments)) ids[r.symbol] = r.id;
  for (const r of await t.owner.db.select().from(strategyLibraryEntries)) {
    ids[`seq${r.sequenceNo}`] = r.registrationNumber;
  }
  for (const who of ['a', 'b'] as const) {
    account[who] = (await as(u[who], (tx) => tx.select().from(tradingAccounts)))[0]!.id;
  }
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('member IDs', () => {
  it('issues U0001, U0002, … in sign-up order, whatever the insert sent', async () => {
    const rows = await t.owner.db
      .select({ id: users.id, code: users.memberCode })
      .from(users)
      .orderBy(users.memberCode);
    expect(rows.map((r) => r.code)).toEqual(['U0001', 'U0002', 'U0003', 'U0004', 'U0005']);
    expect(rows[1]?.id).toBe(u.a);
  });

  it('never changes a member ID', async () => {
    await expect(
      t.auth.db.update(users).set({ memberCode: 'U0042' }).where(eq(users.id, u.a)),
    ).rejects.toThrow();
  });

  it('finds a member by exact ID or email, never the caller or a locked account', async () => {
    await as(u.a, async (tx) => {
      expect(await lookupShareMember(tx, 'u0003')).toMatchObject({
        userId: u.b,
        memberCode: 'U0003',
        displayName: 'Ben',
        isAdmin: false,
      });
      expect((await lookupShareMember(tx, ' BEN@example.test '))?.userId).toBe(u.b);
      expect(await lookupShareMember(tx, 'U0002')).toBeNull();
      expect(await lookupShareMember(tx, 'ben@')).toBeNull();
      expect((await lookupShareMember(tx, 'U0001'))?.isAdmin).toBe(true);
    });
    await t.ownerSql`update "user" set locked_at = now() where id = ${u.c}`;
    await as(u.a, async (tx) => expect(await lookupShareMember(tx, 'U0004')).toBeNull());
    await t.ownerSql`update "user" set locked_at = null where id = ${u.c}`;
  });

  it('lists members for the admin only', async () => {
    const list = await as(u.admin, (tx) => listShareMembers(tx));
    expect(list.map((m) => m.memberCode)).toEqual(['U0002', 'U0003', 'U0004', 'U0005']);
    await expect(as(u.a, (tx) => listShareMembers(tx))).rejects.toBeInstanceOf(ShareError);
  });
});

describe('sharing a Library record', () => {
  it('refuses yourself, nobody, retired records and unknown people', async () => {
    await refused(
      as(u.a, (tx) =>
        createShares(tx, u.a, {
          source: { kind: 'library', number: 'S00001-SD' },
          recipients: ['U0002'],
        }),
      ),
      /yourself/,
    );
    await refused(
      as(u.a, (tx) =>
        createShares(tx, u.a, { source: { kind: 'library', number: 'S00001-SD' }, recipients: [] }),
      ),
      /Choose who/,
    );
    await refused(
      as(u.a, (tx) =>
        createShares(tx, u.a, {
          source: { kind: 'library', number: 'S00001-SD' },
          recipients: ['U0077'],
        }),
      ),
      /can’t receive shares/,
    );
    await refused(
      as(u.a, (tx) =>
        createShares(tx, u.a, {
          source: { kind: 'library', number: 'S00001-SD' },
          recipients: ['U0003'],
          allMembers: true,
        }),
      ),
      /Only the admin/,
    );
  });

  it('makes a pending share and tells the recipient', async () => {
    const [share] = await as(u.a, (tx) =>
      createShares(tx, u.a, {
        source: { kind: 'library', number: 'sds-0001' },
        recipients: ['ben@example.test'],
        note: 'Worth a look',
      }),
    );
    ids.libShare = share!.id;
    expect(share).toMatchObject({
      kind: 'library',
      status: 'pending',
      role: 'sender',
      sourceNumber: 'S00001-SD',
      sender: { code: 'U0002', name: 'Ann', isAdmin: false, label: 'Ann (U0002)' },
      recipient: { code: 'U0003', label: 'Ben (U0003)' },
      note: 'Worth a look',
      result: null,
    });
    const days = (share!.expiresAt.getTime() - share!.createdAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    const inbox = await as(u.b, (tx) => listNotifications(tx));
    expect(inbox.notifications[0]).toMatchObject({
      kind: 'share_received',
      title: expect.stringMatching(/^Ann \(U0002\) shared S00001-SD .+ with you$/),
      body: 'Worth a look',
      link: `/sharing/${share!.id}`,
    });
    expect(await as(u.b, (tx) => pendingShareCount(tx, u.b))).toBe(1);
    const received = await as(u.b, (tx) => listShares(tx, u.b, { box: 'received' }));
    expect(received.map((s) => [s.id, s.role])).toEqual([[share!.id, 'recipient']]);
    const preview = await as(u.b, (tx) => getShare(tx, u.b, share!.id));
    expect(preview?.snapshot.record).toMatchObject({ assetClassCode: 'S', timeframeCode: 'D' });
    expect(preview?.snapshot.strategy).toBeUndefined();
  });

  it('refuses a second pending share of the same record to the same person', async () => {
    await refused(
      as(u.a, (tx) =>
        createShares(tx, u.a, {
          source: { kind: 'library', number: 'S00001-SD' },
          recipients: ['U0003'],
        }),
      ),
      /Already shared with U0003, waiting for an answer/,
    );
  });

  it('is invisible to anyone but its two people', async () => {
    expect(await as(u.c, (tx) => getShare(tx, u.c, ids.libShare!))).toBeNull();
    await refused(
      as(u.c, (tx) => acceptShare(tx, u.c, ids.libShare!)),
      /not found/,
    );
    await refused(
      as(u.c, (tx) => declineShare(tx, ids.libShare!)),
      /not found/,
    );
    await refused(
      as(u.b, (tx) => withdrawShare(tx, ids.libShare!)),
      /not found/,
    );
    await expect(t.appSql`insert into strategy_share (kind) values ('library')`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('accepts into a new record with the next number, tagged and traced', async () => {
    const expected = await nextNumber();
    const accepted = await as(u.b, (tx) => acceptShare(tx, u.b, ids.libShare!));
    expect(accepted).toEqual({
      kind: 'library',
      number: `S${String(expected).padStart(5, '0')}-SD`,
      strategyId: null,
    });
    ids.libCopy = accepted.number;
    const copy = await as(u.b, (tx) => getLibraryEntry(tx, u.b, accepted.number));
    const source = await as(u.b, (tx) => getLibraryEntry(tx, u.b, 'S00001-SD'));
    expect(copy).toMatchObject({
      name: source!.name,
      entry: source!.entry,
      registeredBy: 'you',
      builtStatus: 'not_built',
      copiedFrom: 'S00001-SD',
      sharedBy: { senderName: 'Ann', senderCode: 'U0002', sourceNumber: 'S00001-SD' },
    });
    expect(copy!.tags).toContain('shared');
    expect(copy!.revisions.map((r) => r.note)).toContain('Copied from S00001-SD, shared by U0002');
    // The sender sees it too; anyone else sees only where it was copied from.
    expect(
      (await as(u.a, (tx) => getLibraryEntry(tx, u.a, accepted.number)))?.sharedBy,
    ).toBeTruthy();
    const other = await as(u.c, (tx) => getLibraryEntry(tx, u.c, accepted.number));
    expect(other).toMatchObject({ copiedFrom: 'S00001-SD', sharedBy: null });

    const sent = await as(u.a, (tx) => getShare(tx, u.a, ids.libShare!));
    expect(sent).toMatchObject({
      status: 'accepted',
      result: { number: accepted.number, strategyId: null },
    });
    const told = await as(u.a, (tx) => listNotifications(tx));
    expect(told.notifications[0]).toMatchObject({
      kind: 'share_accepted',
      title: `Ben (U0003) accepted S00001-SD; their copy is ${accepted.number}`,
    });
    expect(await as(u.b, (tx) => pendingShareCount(tx, u.b))).toBe(0);
  });

  it('returns the first copy for a repeated accept, and refuses other answers', async () => {
    const before = await nextNumber();
    const again = await as(u.b, (tx) => acceptShare(tx, u.b, ids.libShare!));
    expect(again.number).toBe(ids.libCopy);
    expect(await nextNumber()).toBe(before);
    await refused(
      as(u.b, (tx) => declineShare(tx, ids.libShare!)),
      /already accepted/,
    );
  });

  it('filters the Library to my records and my shared copies', async () => {
    const shared = await as(u.b, (tx) => listLibraryEntries(tx, { mine: 'shared', viewerId: u.b }));
    expect(shared.items.map((e) => e.registrationNumber)).toEqual([ids.libCopy]);
    const theirs = await as(u.a, (tx) => listLibraryEntries(tx, { mine: 'shared', viewerId: u.a }));
    expect(theirs.total).toBe(0);
  });

  it('refuses a retired record', async () => {
    const entry = await as(u.b, (tx) => getLibraryEntry(tx, u.b, ids.libCopy!));
    await as(u.b, (tx) =>
      retireLibraryEntry(tx, u.b, ids.libCopy!, { reason: 'Test', rowVersion: entry!.rowVersion }),
    );
    await refused(
      as(u.b, (tx) =>
        createShares(tx, u.b, {
          source: { kind: 'library', number: ids.libCopy! },
          recipients: ['U0002'],
        }),
      ),
      /retired/,
    );
  });

  it('can’t give someone else’s share to a copy', async () => {
    const s = await as(u.c, (tx) => createStrategy(tx, u.c, { name: 'Mine' }));
    await expect(
      as(u.c, (tx) =>
        tx
          .update(strategies)
          .set({ receivedShareId: ids.libShare! })
          .where(eq(strategies.id, s.id)),
      ),
    ).rejects.toThrow();
  });
});

describe('sharing a Strategy Lab strategy', () => {
  it('refuses a strategy with no number yet', async () => {
    const draft = await as(u.a, (tx) => createStrategy(tx, u.a, { name: 'Draft' }));
    await refused(
      as(u.a, (tx) =>
        createShares(tx, u.a, {
          source: { kind: 'lab', strategyId: draft.id },
          recipients: ['U0003'],
        }),
      ),
      /has a number/,
    );
    await refused(
      as(u.b, (tx) =>
        createShares(tx, u.b, {
          source: { kind: 'lab', strategyId: draft.id },
          recipients: ['U0002'],
        }),
      ),
      /not found/,
    );
  });

  it('copies the strategy and its record into the recipient’s Lab with new numbers', async () => {
    const mine = await as(u.a, (tx) =>
      createStrategy(tx, u.a, {
        name: 'Ann’s momentum',
        description: 'Buys strength',
        tags: ['momentum'],
        definition: definition('DEMO-A', account.a!),
      }),
    );
    ids.annStrategy = mine.id;
    const sourceNumber = mine.library!.registrationNumber;
    const [share] = await as(u.a, (tx) =>
      createShares(tx, u.a, {
        source: { kind: 'lab', strategyId: mine.id },
        recipients: ['U0003'],
      }),
    );
    expect(share).toMatchObject({ kind: 'lab', sourceNumber, sourceName: 'Ann’s momentum' });
    // Later edits by the sender don't change what was shared.
    await as(u.a, (tx) =>
      updateStrategy(tx, u.a, mine.id, { rowVersion: mine.rowVersion, name: 'Renamed later' }),
    );

    const expected = await nextNumber();
    const accepted = await as(u.b, (tx) => acceptShare(tx, u.b, share!.id));
    expect(accepted.kind).toBe('lab');
    expect(accepted.number.slice(0, 6)).toBe(`S${String(expected).padStart(5, '0')}`);
    expect(accepted.number).not.toBe(sourceNumber);

    const copy = await as(u.b, (tx) => getStrategy(tx, accepted.strategyId!));
    expect(copy).toMatchObject({
      name: 'Ann’s momentum',
      description: 'Buys strength',
      tags: ['momentum'],
      status: 'created',
      versions: [],
      library: { registrationNumber: accepted.number },
      sharedBy: { senderCode: 'U0002', senderName: 'Ann', sourceNumber },
    });
    const accounts = new Set(
      [...copy.definition.entry.orders, ...copy.definition.exit.orders].map((o) => o.accountId),
    );
    expect([...accounts]).toEqual([account.b]);
    const list = await as(u.b, (tx) => listStrategies(tx, { shared: true }));
    expect(list.items.map((s) => [s.id, s.shared])).toEqual([[accepted.strategyId, true]]);

    const record = await as(u.b, (tx) => getLibraryEntry(tx, u.b, accepted.number));
    expect(record).toMatchObject({
      builtStatus: 'built',
      builtStrategy: { visibility: 'yours', id: accepted.strategyId },
      copiedFrom: sourceNumber,
    });
    // The sender's strategy and record are untouched.
    const theirs = await as(u.a, (tx) => getStrategy(tx, mine.id));
    expect(theirs).toMatchObject({ name: 'Renamed later', sharedBy: null });
    expect(theirs.library?.registrationNumber).toBe(sourceNumber);
  });

  it('leaves legs without an account when the recipient has none', async () => {
    await as(u.c, (tx) => tx.update(tradingAccounts).set({ isActive: false }));
    const [share] = await as(u.a, (tx) =>
      createShares(tx, u.a, {
        source: { kind: 'lab', strategyId: ids.annStrategy! },
        recipients: ['cat@example.test'],
      }),
    );
    const accepted = await as(u.c, (tx) => acceptShare(tx, u.c, share!.id));
    const copy = await as(u.c, (tx) => getStrategy(tx, accepted.strategyId!));
    expect(copy.definition.entry.orders[0]?.accountId).toBe(NO_ACCOUNT);
  });
});

describe('declining, withdrawing and expiring', () => {
  it('declines and tells the sender', async () => {
    const [share] = await as(u.admin, (tx) =>
      createShares(tx, u.admin, {
        source: { kind: 'library', number: num(2) },
        recipients: [],
        allMembers: true,
      }),
    ).then((all) => all.filter((s) => s.recipient.code === 'U0003'));
    expect(share!.sender).toMatchObject({ code: 'U0001', isAdmin: true });
    await as(u.b, (tx) => declineShare(tx, share!.id));
    await refused(
      as(u.b, (tx) => acceptShare(tx, u.b, share!.id)),
      /was declined/,
    );
    const told = await as(u.admin, (tx) => listNotifications(tx));
    expect(told.notifications[0]).toMatchObject({
      kind: 'share_declined',
      title: `Ben (U0003) declined ${num(2)}`,
    });
    const sent = await as(u.admin, (tx) => listShares(tx, u.admin, { box: 'sent' }));
    expect(sent).toHaveLength(4);
  });

  it('lets the sender withdraw, and a muted kind creates no notification', async () => {
    await as(u.c, (tx) => updateNotificationPrefs(tx, { userId: u.c, muted: ['share_received'] }));
    const before = (await as(u.c, (tx) => listNotifications(tx))).notifications.length;
    const [share] = await as(u.a, (tx) =>
      createShares(tx, u.a, { source: { kind: 'library', number: num(3) }, recipients: ['U0004'] }),
    );
    expect((await as(u.c, (tx) => listNotifications(tx))).notifications.length).toBe(before);
    await refused(
      as(u.c, (tx) => withdrawShare(tx, share!.id)),
      /not found/,
    );
    await as(u.a, (tx) => withdrawShare(tx, share!.id));
    expect((await as(u.c, (tx) => getShare(tx, u.c, share!.id)))?.status).toBe('withdrawn');
  });

  it('expires shares nobody answered in 30 days', async () => {
    const [share] = await as(u.a, (tx) =>
      createShares(tx, u.a, { source: { kind: 'library', number: num(4) }, recipients: ['U0003'] }),
    );
    await t.ownerSql`update strategy_share set expires_at = now() - interval '1 minute' where id = ${share!.id}`;
    expect((await as(u.b, (tx) => getShare(tx, u.b, share!.id)))?.status).toBe('expired');
    await refused(
      as(u.b, (tx) => acceptShare(tx, u.b, share!.id)),
      /expired/,
    );
    expect(await expireShares(t.worker.db)).toBe(1);
    const [row] = await t.owner.db
      .select({ status: strategyShares.status })
      .from(strategyShares)
      .where(eq(strategyShares.id, share!.id));
    expect(row?.status).toBe('expired');
  });

  it('closes pending shares when an account is deleted', async () => {
    const [toGone] = await as(u.a, (tx) =>
      createShares(tx, u.a, { source: { kind: 'library', number: num(5) }, recipients: ['U0005'] }),
    );
    const [fromGone] = await as(u.gone, (tx) =>
      createShares(tx, u.gone, {
        source: { kind: 'library', number: num(5) },
        recipients: ['U0002'],
      }),
    );
    await as(u.gone, (tx) => prepareAccountDeletion(tx, u.gone));
    expect((await as(u.a, (tx) => getShare(tx, u.a, toGone!.id)))?.status).toBe('declined');
    expect((await as(u.a, (tx) => getShare(tx, u.a, fromGone!.id)))?.status).toBe('withdrawn');
  });
});

describe('sharing several at once', () => {
  const sent = async () => (await as(u.c, (tx) => listShares(tx, u.c, { box: 'sent' }))).length;

  it('shares each one with each person in one send', async () => {
    const shares = await as(u.c, (tx) =>
      createShares(tx, u.c, {
        sources: [
          { kind: 'library', number: num(2) },
          { kind: 'library', number: num(3) },
          { kind: 'library', number: num(2).toLowerCase() },
        ],
        recipients: ['U0001', 'U0003'],
        note: 'A few to try',
      }),
    );
    expect(shares).toHaveLength(4);
    expect(new Set(shares.map((s) => `${s.sourceNumber} ${s.recipient.code}`))).toEqual(
      new Set([`${num(2)} U0001`, `${num(2)} U0003`, `${num(3)} U0001`, `${num(3)} U0003`]),
    );
    expect(shares.every((s) => s.note === 'A few to try')).toBe(true);
  });

  it('refuses the whole send, naming the number, when one can’t be shared', async () => {
    const before = await sent();
    await refused(
      as(u.c, (tx) =>
        createShares(tx, u.c, {
          sources: [
            { kind: 'library', number: num(4) },
            { kind: 'library', number: num(2) },
          ],
          recipients: ['U0003'],
        }),
      ),
      new RegExp(`^${num(2)}: Already shared with U0003`),
    );
    await refused(
      as(u.c, (tx) =>
        createShares(tx, u.c, {
          sources: [
            { kind: 'library', number: num(4) },
            { kind: 'library', number: 'S99999-SD' },
          ],
          recipients: ['U0003'],
        }),
      ),
      /S99999-SD is not in the Library/,
    );
    expect(await sent()).toBe(before);
  });

  it('needs exactly one of source and sources', async () => {
    await refused(
      as(u.c, (tx) => createShares(tx, u.c, { recipients: ['U0003'] })),
      /Choose what to share/,
    );
    await refused(
      as(u.c, (tx) =>
        createShares(tx, u.c, {
          source: { kind: 'library', number: num(4) },
          sources: [{ kind: 'library', number: num(5) }],
          recipients: ['U0003'],
        }),
      ),
      /Choose what to share/,
    );
    await refused(
      as(u.c, (tx) =>
        createShares(tx, u.c, {
          sources: Array.from({ length: 21 }, (_, i) => ({
            kind: 'library' as const,
            number: `S${String(i + 1).padStart(5, '0')}-SD`,
          })),
          recipients: ['U0003'],
        }),
      ),
      /up to 20 at a time/,
    );
  });
});

describe('the copies never reuse a number', () => {
  it('keeps one live strategy per record and every number unique', async () => {
    const rows = await t.owner.db
      .select({ n: strategyLibraryEntries.registrationNumber })
      .from(strategyLibraryEntries);
    expect(new Set(rows.map((r) => r.n)).size).toBe(rows.length);
  });
});
