/**
 * Local development only: creates login users for the tm_app and tm_auth group
 * roles, and the worker's login (tm_app plus tm_secrets, ADR 0015). In deployed environments these are provisioned by infrastructure with
 * secrets from the secret manager.
 */
import { parseEnv } from '@tm/config';
import postgres from 'postgres';
import { z } from 'zod';

const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  DB_APP_LOGIN_PASSWORD: z.string().min(12),
  DB_AUTH_LOGIN_PASSWORD: z.string().min(12),
  DB_WORKER_LOGIN_PASSWORD: z.string().min(12),
});

// The same logins on the Research Store (ADR 0115), when it has its own database.
// The Research Store has no auth tables, so no tm_auth login there.
await setupLogins(env.DATABASE_URL, true);
if (process.env.RESEARCH_DATABASE_URL) await setupLogins(process.env.RESEARCH_DATABASE_URL, false);

async function setupLogins(url: string, withAuth: boolean) {
  const sql = postgres(url, { max: 1 });
  try {
    for (const [login, role, password] of [
      ['tm_app_login', 'tm_app', env.DB_APP_LOGIN_PASSWORD],
      ['tm_auth_login', 'tm_auth', env.DB_AUTH_LOGIN_PASSWORD],
      ['tm_worker_login', 'tm_app, tm_secrets', env.DB_WORKER_LOGIN_PASSWORD],
    ] as const) {
      if (!withAuth && role === 'tm_auth') continue;
      const [exists] = await sql`select 1 from pg_roles where rolname = ${login}`;
      const verb = exists ? 'ALTER' : 'CREATE';
      const [row] = await sql<{ stmt: string }[]>`
      select format('%s ROLE %I LOGIN PASSWORD %L', ${verb}::text, ${login}::text, ${password}::text) as stmt`;
      if (!row) throw new Error('could not build role statement');
      await sql.unsafe(row.stmt);
      await sql.unsafe(`GRANT ${role} TO ${login}`);
      process.stdout.write(
        `${verb === 'CREATE' ? 'Created' : 'Updated'} ${login} (member of ${role}).\n`,
      );
    }
  } finally {
    await sql.end();
  }
}
