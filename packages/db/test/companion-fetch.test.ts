import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { pairCompanion, unpairCompanion } from '../src/companion';
import {
  answerCompanionFetches,
  clearStaleCompanionFetches,
  COMPANION_FETCH_OPEN_LIMIT,
  FetchRefused,
  queueCompanionFetch,
  takeCompanionFetch,
  type FetchAnswerer,
} from '../src/companion-fetch';
import { companionFetches, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * The Local Companion's data requests (ADR 0118): queued as the person,
 * answered by the worker, handed over once, private to each person, and
 * refused once the companion is unpaired.
 */

let t: TestDatabase;
let alice: string;
let bob: string;
let aliceConn: string;
let bobConn: string;

const asUser = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

const seen: { kind: string; userId: string }[] = [];
const answer = (async (kind, request, userId) => {
  seen.push({ kind, userId });
  if (kind === 'members') return { ids: [], refs: [], echo: request };
  if (kind === 'filings') throw new Error('The company data feed is down');
  return { series: [] };
}) as FetchAnswerer;

beforeAll(async () => {
  t = await createTestDatabase();
  alice = await createUser('fetch-alice@example.com');
  bob = await createUser('fetch-bob@example.com');
  aliceConn = (await asUser(alice, (tx) => pairCompanion(tx, alice))).connection.id;
  bobConn = (await asUser(bob, (tx) => pairCompanion(tx, bob))).connection.id;
});

afterAll(async () => {
  await t?.drop();
});

describe('Local Companion data requests (ADR 0118)', () => {
  const who = () => ({ connectionId: aliceConn, userId: alice });

  it('answers a request once, then forgets it', async () => {
    const { id } = await asUser(alice, (tx) =>
      queueCompanionFetch(tx, who(), 'members', { universe: 'sp500' }),
    );
    expect(await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, id))).toEqual({
      status: 'pending',
    });
    const done = await answerCompanionFetches({ core: t.worker.db, answer });
    expect(done).toEqual([{ id, kind: 'members' }]);
    expect(seen).toEqual([{ kind: 'members', userId: alice }]);
    expect(await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, id))).toEqual({
      status: 'done',
      answer: { ids: [], refs: [], echo: { universe: 'sp500' } },
    });
    expect(await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, id))).toBeNull();
  });

  it('records why a request failed', async () => {
    const { id } = await asUser(alice, (tx) =>
      queueCompanionFetch(tx, who(), 'filings', {
        instruments: [{ id: '00000000-0000-4000-8000-000000000001', symbol: 'AAPL' }],
      }),
    );
    await answerCompanionFetches({ core: t.worker.db, answer });
    expect(await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, id))).toEqual({
      status: 'failed',
      error: 'The company data feed is down',
    });
  });

  it('refuses a malformed request the web app did not check', async () => {
    const { id } = await asUser(alice, (tx) =>
      queueCompanionFetch(tx, who(), 'bars', { requests: 'everything' } as never),
    );
    const [done] = await answerCompanionFetches({ core: t.worker.db, answer });
    expect(done).toEqual({ id, kind: 'bars', error: 'The request is malformed' });
    await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, id));
  });

  it('takes the factor store’s request kinds (ADR 0119)', async () => {
    const { id } = await asUser(alice, (tx) =>
      queueCompanionFetch(tx, who(), 'pattern_members', {}),
    );
    const { id: sig } = await asUser(alice, (tx) =>
      queueCompanionFetch(tx, who(), 'option_signals', {
        ids: ['00000000-0000-4000-8000-000000000001'],
        from: '2025-01-02',
      }),
    );
    const done = await answerCompanionFetches({ core: t.worker.db, answer });
    expect(done.map((d) => d.id)).toEqual([id, sig]);
    await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, id));
    await asUser(alice, (tx) => takeCompanionFetch(tx, aliceConn, sig));
  });

  it('lets a companion have only a few requests open at once', async () => {
    for (let i = 0; i < COMPANION_FETCH_OPEN_LIMIT; i += 1) {
      await asUser(alice, (tx) => queueCompanionFetch(tx, who(), 'members', { universe: 'x' }));
    }
    await expect(
      asUser(alice, (tx) => queueCompanionFetch(tx, who(), 'members', { universe: 'x' })),
    ).rejects.toBeInstanceOf(FetchRefused);
    await answerCompanionFetches({ core: t.worker.db, answer });
  });

  it('keeps each person’s requests to themselves', async () => {
    const { id } = await asUser(alice, (tx) =>
      queueCompanionFetch(tx, who(), 'members', { universe: 'mine' }),
    );
    expect(await asUser(bob, (tx) => takeCompanionFetch(tx, aliceConn, id))).toBeNull();
    expect(await asUser(bob, (tx) => takeCompanionFetch(tx, bobConn, id))).toBeNull();
    await answerCompanionFetches({ core: t.worker.db, answer });
  });

  it('does not answer once the companion is unpaired, and clears what nobody read', async () => {
    const { id } = await asUser(bob, (tx) =>
      queueCompanionFetch(tx, { connectionId: bobConn, userId: bob }, 'events', {
        ids: ['00000000-0000-4000-8000-000000000001'],
      }),
    );
    await asUser(bob, (tx) => unpairCompanion(tx, bob, bobConn));
    seen.length = 0;
    const done = await answerCompanionFetches({ core: t.worker.db, answer });
    expect(done).toEqual([
      { id, kind: 'events', error: 'The companion was unpaired before this request was answered' },
    ]);
    expect(seen).toEqual([]);
    await t.owner.db.execute(
      sql`update companion_fetch set requested_at = now() - interval '2 hours'`,
    );
    expect(await clearStaleCompanionFetches(t.worker.db)).toBeGreaterThan(0);
    expect(await t.owner.db.select().from(companionFetches)).toEqual([]);
  });
});
