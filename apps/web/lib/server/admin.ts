import 'server-only';
import { isPlatformAdmin, withTenant, type Transaction } from '@tm/db';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { appDb } from './db';
import { requireTenant, type SessionTenant } from './session';

/** Whether the signed-in person may see the admin page (ADR 0037). */
export const isAdmin = cache(async (): Promise<boolean> => {
  const tenant = await requireTenant();
  return withTenant(appDb(), tenant, isPlatformAdmin);
});

/**
 * For admin pages and actions: the signed-in admin, or a 404 for anyone else,
 * so the page does not reveal it exists. The database functions check again.
 */
export async function requireAdmin(): Promise<SessionTenant> {
  const tenant = await requireTenant();
  if (!(await isAdmin())) notFound();
  return tenant;
}

/** Runs admin database calls as the signed-in admin. */
export async function asAdmin<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tenant = await requireAdmin();
  return withTenant(appDb(), tenant, fn);
}
