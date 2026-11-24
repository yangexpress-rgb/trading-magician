import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDb, type DbHandle } from '../src/client';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { MIGRATIONS_FOLDER, runMigrations } from '../src/migrate';
import { runResearchMigrations } from '../src/research';
import { seedReferenceData } from '../src/seed';

// The tests run on the invented demo instruments and demo feed (ADR 0039).
process.env.DEMO_DATA ??= 'on';

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
  /** The Research Store's own database, when asked for (ADR 0115). */
  research?: ResearchTestDatabase;
  drop: () => Promise<void>;
}

export interface ResearchTestDatabase {
  owner: DbHandle;
  app: DbHandle;
  worker: DbHandle;
  ownerSql: postgres.Sql;
  /** Stops the Research database for good: connections are cut and it is dropped. */
  stop: () => Promise<void>;
}

/** Advisory lock key, on the admin database, held while a test database migrates. */
const MIGRATION_LOCK = 7_231_001;

export async function createTestDatabase(
  options: {
    /** False keeps a new library on convention v1 (to test the v2 renumbering). */
    renumberFreshLibrary?: boolean;
    /** False migrates without seeding the library (the test seeds it as it needs). */
    seedLibrary?: boolean;
    /** Also create a separate Research Store database (ADR 0115). */
    research?: boolean;
  } = {},
): Promise<TestDatabase> {
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
    if (options.seedLibrary === false) {
      await migrate(owner.db, { migrationsFolder: MIGRATIONS_FOLDER });
    } else await runMigrations(owner.db, { renumberFreshLibrary: options.renumberFreshLibrary });
  } finally {
    await admin`select pg_advisory_unlock(${MIGRATION_LOCK})`;
  }
  await seedReferenceData(owner.db, { demo: true });
  // Most tests create more strategies than the Free plan keeps; new workspaces
  // start on the dev plan here. entitlements.test.ts covers the real default.
  await owner.db.execute(sql`update plan set is_default = false`);
  await owner.db.execute(sql`update plan set is_default = true where code = 'dev'`);
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

  let research: ResearchTestDatabase | undefined;
  const researchName = `${dbName}_r`;
  if (options.research) {
    await admin.unsafe(`CREATE DATABASE ${researchName}`);
    const rurl = (user?: string) => {
      const u = new URL(url(user));
      u.pathname = `/${researchName}`;
      return u.toString();
    };
    const rOwner = createDb(rurl(), { max: 2 });
    await admin`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await runResearchMigrations(rOwner.db);
    } finally {
      await admin`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
    const rApp = createDb(rurl(appLogin), { max: 4 });
    const rWorker = createDb(rurl(workerLogin), { max: 2 });
    const rOwnerSql = postgres(rurl(), { max: 2, onnotice: () => undefined });
    let stopped = false;
    const closeAll = () =>
      Promise.all([rOwner.close(), rApp.close(), rWorker.close(), rOwnerSql.end()]);
    research = {
      owner: rOwner,
      app: rApp,
      worker: rWorker,
      ownerSql: rOwnerSql,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await admin.unsafe(`DROP DATABASE IF EXISTS ${researchName} WITH (FORCE)`);
        await closeAll().catch(() => undefined);
      },
    };
  }

  return {
    owner,
    app,
    auth,
    worker,
    ownerSql,
    appSql,
    appUrl: url(appLogin),
    ...(research ? { research } : {}),
    drop: async () => {
      await research?.stop();
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
