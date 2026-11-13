import type { PatternScanConfig } from '@tm/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  getPattern,
  getPatternScan,
  listPatternScans,
  promotePattern,
  queuePatternScan,
  requestReverify,
  theoryNumberById,
} from '../src/patterns';
import { provisionWorkspace } from '../src/provision';
import { patterns, strategies, strategyLibraryEntries, users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

/**
 * Pattern discovery's stored scans and patterns (pattern brief §6, §9, §10,
 * ADR 0091): scans are private to their owner, a pattern's evidence cannot be
 * rewritten, and promotion (fixture 6) creates exactly one theory with the
 * evidence text and the link back, and no strategy.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let scanId: string;
let patternId: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  return row!.id;
}

const config: PatternScanConfig = {
  universe: { kind: 'group', id: 'sp500' },
  outcome: { direction: 'spike', pct: 8, horizon: 15 },
  categories: ['price', 'fundamentals'],
  maxDepth: 3,
  minSupport: 40,
  range: {},
  split: { discovery: 0.7 },
  memberIds: [],
  factors: [],
  catalogueVersion: 1,
};

const stats = {
  discovery: {
    n: 300,
    hits: 120,
    rate: 0.4,
    baseRate: 0.2,
    lift: 2,
    wilsonLower: 0.35,
    pValue: 1e-9,
  },
  holdout: {
    n: 55,
    hits: 41,
    rate: 41 / 55,
    baseRate: 0.21,
    lift: 3.5,
    wilsonLower: 0.62,
    pValue: 1e-12,
  },
  level: 2,
  failedChecks: [],
};

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('pat-a@example.test');
  userB = await createUser('pat-b@example.test');
  await provisionWorkspace(t.app.db, { userId: userA, displayName: 'A' });
  await provisionWorkspace(t.app.db, { userId: userB, displayName: 'B' });
  scanId = await as(userA, (tx) => queuePatternScan(tx, userA, config, 'S&P 500: Spike +8% / 15d'));
  // The miner's writes (worker login): the scan's result and one verified pattern.
  await t.owner.db.execute(sql`
    update pattern_scan set status = 'done', candidates_tested = 1234, finalists = 1, verified = 1,
      effective = ${JSON.stringify({ from: '2016-01-04', discoveryEnd: '2022-12-30', holdoutStart: '2023-01-03', to: '2026-11-12' })}::jsonb,
      finished_at = now()
    where id = ${scanId}`);
  const [row] = await t.owner.db
    .insert(patterns)
    .values({
      scanId,
      userId: userA,
      rank: 1,
      rule: [
        { factor: 'return_21d', mode: 'cross', bucket: 'top' },
        { factor: 'volume_ratio_60', mode: 'own', bucket: 'high' },
      ],
      stats,
      status: 'verified',
    })
    .returning({ id: patterns.id });
  patternId = row!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('pattern scans', () => {
  it('are queued for the owner and invisible to others', async () => {
    const mine = await as(userA, (tx) => listPatternScans(tx));
    expect(mine.map((s) => s.id)).toEqual([scanId]);
    expect(await as(userB, (tx) => listPatternScans(tx))).toEqual([]);
    expect(await as(userB, (tx) => getPattern(tx, patternId))).toBeUndefined();
  });

  it("keep a pattern's evidence fixed", async () => {
    await expect(
      as(userA, (tx) =>
        tx.update(patterns).set({ status: 'candidate' }).where(eq(patterns.id, patternId)),
      ),
    ).rejects.toThrow();
    await as(userA, (tx) => requestReverify(tx, patternId));
    const p = await as(userA, (tx) => getPattern(tx, patternId));
    expect(p?.status).toBe('verified');
    expect(p?.decayStats?.reverifyRequestedAt).toBeTruthy();
  });
});

describe('promotion (fixture 6)', () => {
  it('creates exactly one theory with the evidence and the link, and no strategy', async () => {
    const before = await t.owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(strategyLibraryEntries);
    const strategiesBefore = await t.owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(strategies);
    const result = await as(userA, async (tx) => {
      const p = (await getPattern(tx, patternId))!;
      const s = (await getPatternScan(tx, scanId))!;
      return promotePattern(tx, userA, p, s);
    });
    expect(result.registrationNumber).toMatch(/^T/);
    const after = await t.owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(strategyLibraryEntries);
    const strategiesAfter = await t.owner.db
      .select({ n: sql<number>`count(*)::int` })
      .from(strategies);
    expect(after[0]!.n).toBe(before[0]!.n + 1);
    expect(strategiesAfter[0]!.n).toBe(strategiesBefore[0]!.n);

    const [entry] = await t.owner.db
      .select()
      .from(strategyLibraryEntries)
      .where(eq(strategyLibraryEntries.id, result.id));
    expect(entry!.name).toContain('Pattern: ');
    expect(entry!.longDescription).toContain('41 of 55 (75%)');
    expect(entry!.longDescription).toContain('1234 rules');
    expect(entry!.longDescription).toContain('survivorship');

    const p = await as(userA, (tx) => getPattern(tx, patternId));
    expect(p?.promotedTheoryId).toBe(result.id);
    expect(p?.promotedStatus).toBe('verified');
    expect(await as(userA, (tx) => theoryNumberById(tx, result.id))).toBe(
      result.registrationNumber,
    );
  });

  it('refuses a second promotion', async () => {
    await expect(
      as(userA, async (tx) => {
        const p = (await getPattern(tx, patternId))!;
        const s = (await getPatternScan(tx, scanId))!;
        return promotePattern(tx, userA, p, s);
      }),
    ).rejects.toThrow(/already in the Theory Library/);
  });
});
