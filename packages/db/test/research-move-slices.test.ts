import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { moveTable } from '../src/research-move';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase({ research: true });
}, 90_000);
afterAll(async () => t?.drop());

/** The Research copy (ADR 0115) across many slices, on two-connection pools like the command's. */
it('copies a table in many slices, row for row identical', async () => {
  const [inst] = await t.ownerSql<{ id: string }[]>`select id from instrument limit 1`;
  await t.ownerSql`insert into option_contract (underlying_id, expiry, strike, "right", occ_symbol)
    select ${inst!.id}, '2027-01-01'::date + (g % 300), 1 + g, 'call', 'X' || g from generate_series(1, 200000) g`;
  const dbName = (await t.ownerSql<{ d: string }[]>`select current_database() as d`)[0]!.d;
  const base = new URL(process.env.TEST_DATABASE_URL!);
  base.pathname = `/${dbName}`;
  const core = postgres(base.toString(), { max: 2, onnotice: () => undefined });
  base.pathname = `/${dbName}_r`;
  const research = postgres(base.toString(), { max: 2, onnotice: () => undefined });
  const m = await moveTable(core, research, 'option_contract', () => undefined, 200);
  expect(m).toMatchObject({ coreRows: 200000, inserted: 200000, researchAfter: 200000 });
  const digest = (sql: postgres.Sql) =>
    sql<
      { d: string }[]
    >`select md5(string_agg(t::text, ',' order by id)) as d from option_contract t`;
  expect((await digest(research))[0]!.d).toBe((await digest(core))[0]!.d);
  const again = await moveTable(core, research, 'option_contract', () => undefined, 200);
  expect(again.inserted).toBe(0);
  await core.end();
  await research.end();
}, 120_000);
