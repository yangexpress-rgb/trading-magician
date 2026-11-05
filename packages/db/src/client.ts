import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbHandle {
  db: Database;
  close: () => Promise<void>;
}

/**
 * Opens a connection pool. Use the role-specific URL for the job: the owner URL
 * only for migrations and seeding, the app URL for request handling, the auth
 * URL only inside the authentication library.
 */
export function createDb(url: string, options: { max?: number } = {}): DbHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
