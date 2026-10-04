import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, type DbHandle } from '../src/client';
import { runMigrations } from '../src/migrate';
import { seedReferenceData } from '../src/seed';

/**
 * Creates a throwaway database with migrations and seed applied, plus login
 * users for the tm_app and tm_auth roles, so tests exercise the real grants and
 * row-level security policies rather than the superuser's view.
 *
 * Requires TEST_DATABASE_URL: a connection with rights to create databases and roles.
 */
export interface TestDatabase {
  owner: DbHandle;
  app: DbHandle;
  auth: DbHandle;
  /** The worker's login: tm_app plus tm_secrets, which may read sealed credentials. */
  worker: DbHandle;
  ownerSql: postgres.Sql;
  appSql: postgres.Sql;
  /** Connection string for the tenant-scoped login. */
  appUrl: string;
  drop: () => Promise<void>;
}

/** Advisory lock key, on the admin database, held while a test database migrates. */
const MIGRATION_LOCK = 7_231_001;

export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL is required for integration tests');

  const suffix = randomBytes(4).toString('hex');
  const dbName = `tm_test_${suffix}`;
  const appLogin = `tm_app_t${suffix}`;
  const authLogin = `tm_auth_t${suffix}`;
  const workerLogin = `tm_worker_t${suffix}`;
  const password = randomBytes(16).toString('hex');

  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);

  const url = (user?: string) => {
    const u = new URL(adminUrl);
    u.pathname = `/${dbName}`;
    if (user) {
      u.username = user;
      u.password = password;
    }
    return u.toString();
  };

  const owner = createDb(url(), { max: 2 });
  // Roles are cluster-wide: test files that migrate at the same time would race to
  // create tm_app and tm_auth, so one database migrates at a time.
  await admin`select pg_advisory_lock(${MIGRATION_LOCK})`;
  try {
    await runMigrations(owner.db);
  } finally {
    await admin`select pg_advisory_unlock(${MIGRATION_LOCK})`;
  }
  await seedReferenceData(owner.db);
  await admin.unsafe(`CREATE ROLE ${appLogin} LOGIN PASSWORD '${password}' IN ROLE tm_app`);
  await admin.unsafe(`CREATE ROLE ${authLogin} LOGIN PASSWORD '${password}' IN ROLE tm_auth`);
  await admin.unsafe(
    `CREATE ROLE ${workerLogin} LOGIN PASSWORD '${password}' IN ROLE tm_app, tm_secrets`,
  );

  const app = createDb(url(appLogin), { max: 4 });
  const auth = createDb(url(authLogin), { max: 2 });
  const worker = createDb(url(workerLogin), { max: 2 });
  const ownerSql = postgres(url(), { max: 1, onnotice: () => undefined });
  const appSql = postgres(url(appLogin), { max: 1, onnotice: () => undefined });

  return {
    owner,
    app,
    auth,
    worker,
    ownerSql,
    appSql,
    appUrl: url(appLogin),
    drop: async () => {
      await Promise.all([
        owner.close(),
        app.close(),
        auth.close(),
        worker.close(),
        ownerSql.end(),
        appSql.end(),
      ]);
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${appLogin}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${authLogin}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${workerLogin}`);
      await admin.end();
    },
  };
}
