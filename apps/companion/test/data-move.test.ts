import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportResearchSlice, type ResearchExportTable } from '@tm/db';
import { runResearchMigrations } from '@tm/db/research-migrate';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudData } from '../src/cloud-data';
import {
  copyVerified,
  FROM_CLOUD_PUSH_ID,
  markCloudCopies,
  moveResearchData,
} from '../src/data-move';
import { startLocalStore, type LocalStore } from '../src/store';

/**
 * The data move (ADR 0122, S2 step 5), against a real local Postgres: a
 * second database on it stands in for the cloud's Research Store, and the
 * cloud's own slice reader (`exportResearchSlice`, what the worker answers
 * with) serves it. The copy keeps what the companion already made, and a
 * second pass copies nothing.
 */

const isRoot = process.getuid?.() === 0;
const port = 60_000 + Math.floor(Math.random() * 4_000);

let dir: string;
let store: LocalStore;
let cloudSql: postgres.Sql;

describe.skipIf(isRoot)('Data move to the companion (ADR 0122)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-companion-move-'));
    await chmod(dir, 0o700);
    store = await startLocalStore({ home: join(dir, 'home'), port, password: 'pw-move-test' });
    await store.sql.unsafe('CREATE DATABASE cloud_research');
    cloudSql = postgres(store.url.replace(/\/research$/, '/cloud_research'), {
      max: 2,
      onnotice: () => undefined,
    });
    await runResearchMigrations(
      drizzle(cloudSql) as unknown as Parameters<typeof runResearchMigrations>[0],
    );
  }, 120_000);

  afterAll(async () => {
    await cloudSql?.end();
    await store?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('copies every research table and verifies on a second pass, keeping local rows', async () => {
    const user = randomUUID();
    const inst = [randomUUID(), randomUUID()];
    const scans = [randomUUID(), randomUUID()];
    // The cloud's data: factor snapshots over many pages, two scans with a pattern and its occurrences.
    await cloudSql`
      insert into factor_snapshot (as_of, instrument_id, "values", close_ret, catalogue_version)
      select d::date, i, jsonb_build_object('rsi_14', random(), 'pad', repeat('x', 300)), random(), 1
      from generate_series('2020-01-01'::date, '2022-12-31'::date, '1 day') d,
           unnest(${inst}::uuid[]) i`;
    for (const s of scans)
      await cloudSql`insert into pattern_scan (id, user_id, config, summary, status)
                     values (${s}, ${user}, '{}'::jsonb, 'Cloud scan', 'done')`;
    const [p] = await cloudSql<{ id: string }[]>`
      insert into pattern (scan_id, user_id, rank, rule, stats, status)
      values (${scans[0]!}, ${user}, 1, '[]', '{}', 'verified') returning id::text`;
    await cloudSql`
      update pattern set decay_state = 'holding', last_scored = '2026-11-20',
        decay_stats = ${JSON.stringify({ fresh: { n: 3, hitRate: 0.67 }, b: 1, a: [1, 2] })}::text::jsonb
      where id = ${p!.id}`;
    await cloudSql`
      insert into pattern_occurrence (pattern_id, user_id, instrument_id, as_of, "window", hit,
                                      max_runup, max_drawdown, forward_return)
      values (${p!.id}, ${user}, ${inst[0]!}, '2021-03-01', 'holdout', true, 0.1, -0.02, 0.05)`;
    // A scan this computer already ran keeps its local result.
    await store.sql`insert into pattern_scan (id, user_id, config, summary, status)
                    values (${scans[1]!}, ${user}, '{}'::jsonb, 'Mined here', 'done')`;
    // And one only this computer has, not sent yet.
    const onlyHere = randomUUID();
    await store.sql`insert into pattern_scan (id, user_id, config, summary, status)
                    values (${onlyHere}, ${user}, '{}'::jsonb, 'Only here', 'done')`;

    const cloudDb = drizzle(cloudSql) as unknown as Parameters<typeof exportResearchSlice>[0];
    let slices = 0;
    const cloud = {
      ask: async (kind: string, request: unknown) => {
        expect(kind).toBe('research_export');
        slices += 1;
        // Small slices, so the test crosses many of them; JSON both ways, as on the wire.
        const answer = await exportResearchSlice(
          cloudDb,
          request as { table: ResearchExportTable; fromPage: number; count?: boolean },
          8,
        );
        return JSON.parse(JSON.stringify(answer)) as unknown;
      },
    } as unknown as CloudData;

    const result = await moveResearchData(store.sql, cloud);
    expect(result.verified).toBe(true);
    expect(copyVerified(result.copy)).toBe(false);
    const byTable = Object.fromEntries(result.copy.map((c) => [c.table, c]));
    expect(byTable.factor_snapshot).toMatchObject({ cloudRows: 2192, inserted: 2192, skipped: 0 });
    expect(byTable.pattern_scan).toMatchObject({ cloudRows: 2, localBefore: 2, inserted: 1 });
    expect(byTable.pattern_occurrence).toMatchObject({ cloudRows: 1, inserted: 1 });
    expect(slices).toBeGreaterThan(30);
    // Byte for byte the same rows.
    const digest = async (sql: postgres.Sql) =>
      (
        await sql<{ d: string }[]>`
          select md5(string_agg(as_of::text || instrument_id::text || "values"::text || close_ret::text, '|'
                     order by as_of, instrument_id)) as d from factor_snapshot`
      )[0]!.d;
    expect(await digest(store.sql)).toBe(await digest(cloudSql));
    const [mine] = await store.sql<{ summary: string }[]>`
      select summary from pattern_scan where id = ${scans[1]!}`;
    expect(mine!.summary).toBe('Mined here');

    // What came from the cloud is marked as sent, so the companion never pushes it back (N350).
    const pushed = await store.sql<{ client_key: string; push_id: string }[]>`
      select client_key, push_id::text from companion.pushed order by client_key`;
    expect(pushed.every((r) => r.push_id === FROM_CLOUD_PUSH_ID)).toBe(true);
    const keys = pushed.map((r) => r.client_key);
    expect(keys).toEqual(expect.arrayContaining([`scan:${scans[0]!}`, `scan:${scans[1]!}`]));
    expect(keys).not.toContain(`scan:${onlyHere}`);
    // The decay key matches the one the decay job builds from the local copy, so nothing is due.
    const due = await store.sql<{ id: string }[]>`
      select p.id::text from pattern p
      where p.status = 'verified' and p.decay_state is not null and not exists (
        select 1 from companion.pushed x
        where x.client_key = 'decay:' || p.id::text || ':' || p.last_scored::text || ':' || md5(p.decay_stats::text))`;
    expect(due).toEqual([]);
    const [pulled] = await store.sql<{ last_scored: string }[]>`
      select last_scored::text from companion.decay_pulled where pattern_id = ${p!.id}`;
    expect(pulled!.last_scored).toBe('2026-11-20');
    // Running it again (the one-off command) marks nothing new.
    const again = await markCloudCopies(store.sql, cloud);
    expect(again).toEqual({ scans: 0, decayScores: 0, evaluations: 0, reports: 0 });
  }, 120_000);
});
