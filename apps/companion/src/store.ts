import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runResearchMigrations } from '@tm/db/research-migrate';
import { drizzle } from 'drizzle-orm/postgres-js';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';
import { pgDataDir } from './paths';

/**
 * The companion's local Research Store (ADR 0116, S2): a private Postgres
 * that runs inside the companion, listening on 127.0.0.1 only. It gets the
 * same Research Store migrations as the cloud's (so the trainer and miner
 * read and write the same tables), plus a small `companion` schema for the
 * reference data pulled from the cloud and the sync bookkeeping.
 *
 * The local login is the cluster owner; the computer user is the only person
 * on it, so the cloud's row-level security roles exist but are not relied on.
 */

export const RESEARCH_DB = 'research';
const PG_USER = 'companion';

export interface LocalStoreOptions {
  home: string;
  port: number;
  password: string;
  log?: (line: string) => void;
}

export interface LocalStore {
  sql: postgres.Sql;
  url: string;
  stop: () => Promise<void>;
}

/** Local-only tables: reference data from the cloud and what was synced when. */
const COMPANION_SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS companion`,
  `CREATE TABLE IF NOT EXISTS companion.instrument (
     id uuid PRIMARY KEY,
     symbol text NOT NULL,
     asset_class text NOT NULL,
     kind text NOT NULL,
     display_name text NOT NULL,
     venue text NOT NULL,
     currency text NOT NULL,
     synced_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS companion_instrument_symbol_idx ON companion.instrument (symbol)`,
  `CREATE TABLE IF NOT EXISTS companion.membership_period (
     group_id text NOT NULL,
     symbol text NOT NULL,
     instrument_id uuid,
     from_date date NOT NULL,
     to_date date,
     PRIMARY KEY (group_id, symbol, from_date)
   )`,
  `CREATE TABLE IF NOT EXISTS companion.sync_state (
     job text PRIMARY KEY,
     ok_at timestamptz,
     tried_at timestamptz NOT NULL,
     error text,
     detail jsonb NOT NULL DEFAULT '{}'::jsonb
   )`,
  // A local mirror of the cloud's model registry, runs and predictions (ADR
  // 0117): the trainer reads and writes them exactly as it does Core, so it
  // runs here unchanged. The cloud's own rows come down; the companion's go up.
  `CREATE TABLE IF NOT EXISTS ml_model (
     id uuid PRIMARY KEY,
     model_key text NOT NULL UNIQUE,
     name text NOT NULL,
     universe text NOT NULL,
     feature_set jsonb NOT NULL,
     feature_set_version integer NOT NULL,
     label jsonb NOT NULL,
     algorithm text NOT NULL,
     status text NOT NULL,
     snapshots_from date NOT NULL,
     availability jsonb
   )`,
  `CREATE TABLE IF NOT EXISTS ml_model_run (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     model_id uuid NOT NULL REFERENCES ml_model (id),
     run_no integer NOT NULL,
     prediction_date date NOT NULL,
     training_start date NOT NULL,
     training_end date NOT NULL,
     max_label_end date NOT NULL,
     rows_trained integer NOT NULL,
     cross_sections integer NOT NULL,
     hyperparams jsonb NOT NULL,
     coefficients jsonb NOT NULL,
     code_version text NOT NULL,
     status text NOT NULL DEFAULT 'active',
     source text NOT NULL DEFAULT 'companion',
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ml_model_run_embargo CHECK (max_label_end < prediction_date)
   )`,
  // The registry's other columns, so the shared snapshot job (ADR 0118) reads the mirror as it
  // reads Core. Availability is the companion's own once its snapshots report it.
  `ALTER TABLE ml_model ADD COLUMN IF NOT EXISTS theory_number text`,
  `ALTER TABLE ml_model ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`,
  `ALTER TABLE ml_model ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ml_model_run_active_uq
     ON ml_model_run (model_id, prediction_date) WHERE status = 'active'`,
  `CREATE TABLE IF NOT EXISTS ml_prediction (
     model_run_id uuid NOT NULL REFERENCES ml_model_run (id) ON DELETE CASCADE,
     instrument_id uuid NOT NULL,
     as_of date NOT NULL,
     score double precision NOT NULL,
     PRIMARY KEY (model_run_id, instrument_id)
   )`,
  // What has been sent up, so nothing is sent twice.
  `CREATE TABLE IF NOT EXISTS companion.pushed (
     client_key text PRIMARY KEY,
     kind text NOT NULL,
     push_id uuid NOT NULL,
     pushed_at timestamptz NOT NULL DEFAULT now()
   )`,
  // The cloud's last decay score of each pattern pulled to score here (ADR 0121).
  `CREATE TABLE IF NOT EXISTS companion.decay_pulled (
     pattern_id uuid PRIMARY KEY,
     last_scored date
   )`,
];

/** Starts (creating on first run) the local Research Store and brings its tables up to date. */
export async function startLocalStore(options: LocalStoreOptions): Promise<LocalStore> {
  const log = options.log ?? (() => undefined);
  const dataDir = pgDataDir(options.home);
  await mkdir(options.home, { recursive: true, mode: 0o700 });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: PG_USER,
    password: options.password,
    port: options.port,
    persistent: true,
    authMethod: 'scram-sha-256',
    initdbFlags: ['--encoding=UTF8'],
    // Listen on this computer only; nothing else can reach the Research Store.
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => undefined,
    onError: (message: unknown) => log(`postgres: ${String(message).trim()}`),
  });
  const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
  if (fresh) {
    log('Creating the local research database (first run)…');
    await pg.initialise();
  }
  await pg.start();
  const url = `postgres://${PG_USER}:${encodeURIComponent(options.password)}@127.0.0.1:${options.port}/${RESEARCH_DB}`;
  try {
    const admin = postgres(url.replace(`/${RESEARCH_DB}`, '/postgres'), {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const [row] = await admin`select 1 as ok from pg_database where datname = ${RESEARCH_DB}`;
      if (!row) await admin.unsafe(`CREATE DATABASE ${RESEARCH_DB}`);
    } finally {
      await admin.end();
    }
    const sql = postgres(url, { max: 4, onnotice: () => undefined });
    await runResearchMigrations(
      drizzle(sql) as unknown as Parameters<typeof runResearchMigrations>[0],
    );
    for (const statement of COMPANION_SCHEMA) await sql.unsafe(statement);
    log('Local research database is up to date.');
    return {
      sql,
      url,
      stop: async () => {
        await sql.end({ timeout: 5 });
        await pg.stop();
      },
    };
  } catch (error) {
    await pg.stop().catch(() => undefined);
    throw error;
  }
}

/**
 * Connects to a local store that a running companion already started, or
 * returns null. `status` uses this so it can run beside `run`.
 */
export async function connectRunningStore(options: LocalStoreOptions): Promise<LocalStore | null> {
  const url = `postgres://${PG_USER}:${encodeURIComponent(options.password)}@127.0.0.1:${options.port}/${RESEARCH_DB}`;
  const sql = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => undefined });
  try {
    await sql`select 1`;
    return { sql, url, stop: () => sql.end({ timeout: 5 }) };
  } catch {
    await sql.end({ timeout: 1 }).catch(() => undefined);
    return null;
  }
}
