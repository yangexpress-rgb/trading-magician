import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listHeartbeats, pruneRateLimits, rateLimitHit, recordHeartbeat } from '../src/ops';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

describe('shared rate limits', () => {
  it('counts hits across connections and says how long to wait', async () => {
    expect(await rateLimitHit(t.app.db, 'mutate:u1', 2, 60)).toBe(0);
    expect(await rateLimitHit(t.worker.db, 'mutate:u1', 2, 60)).toBe(0);
    const wait = await rateLimitHit(t.app.db, 'mutate:u1', 2, 60);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(await rateLimitHit(t.app.db, 'mutate:u2', 2, 60)).toBe(0);
  });

  it('starts a new window once the old one has passed', async () => {
    await rateLimitHit(t.app.db, 'mutate:u3', 1, 60);
    expect(await rateLimitHit(t.app.db, 'mutate:u3', 1, 60)).toBeGreaterThan(0);
    await t.owner.db.execute(
      sql`update api_rate_limit set window_start = now() - interval '61 seconds' where key = 'mutate:u3'`,
    );
    expect(await rateLimitHit(t.app.db, 'mutate:u3', 1, 60)).toBe(0);
  });

  it('keeps counters out of the app’s reach except through the function', async () => {
    await expect(t.appSql.unsafe('select * from api_rate_limit')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(t.appSql.unsafe('select rate_limit_prune(86400)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('lets the worker prune windows older than a day', async () => {
    await rateLimitHit(t.app.db, 'old:u', 5, 60);
    await t.owner.db.execute(
      sql`update api_rate_limit set window_start = now() - interval '2 days' where key = 'old:u'`,
    );
    expect(await pruneRateLimits(t.worker.db)).toBe(1);
  });
});

describe('heartbeats', () => {
  it('lets the worker mark itself alive and the app read it, but not write it', async () => {
    await recordHeartbeat(t.worker.db, 'worker', 'host:1');
    const [beat] = await listHeartbeats(t.app.db);
    expect(beat?.service).toBe('worker');
    expect(Date.now() - beat!.beatAt.getTime()).toBeLessThan(60_000);
    await expect(recordHeartbeat(t.app.db, 'worker', 'forged')).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });
});
