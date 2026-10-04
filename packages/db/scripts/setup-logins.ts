/**
 * Local development only: creates login users for the tm_app and tm_auth group
 * roles. In deployed environments these are provisioned by infrastructure with
 * secrets from the secret manager.
 */
import { parseEnv } from '@tm/config';
import postgres from 'postgres';
import { z } from 'zod';

const env = parseEnv({
  DATABASE_URL: z.string().min(1),
  DB_APP_LOGIN_PASSWORD: z.string().min(12),
  DB_AUTH_LOGIN_PASSWORD: z.string().min(12),
});

const sql = postgres(env.DATABASE_URL, { max: 1 });
try {
  for (const [login, role, password] of [
    ['tm_app_login', 'tm_app', env.DB_APP_LOGIN_PASSWORD],
    ['tm_auth_login', 'tm_auth', env.DB_AUTH_LOGIN_PASSWORD],
  ] as const) {
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
