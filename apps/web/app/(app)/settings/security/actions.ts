'use server';

import { eq, prepareAccountDeletion, schema, withTenant } from '@tm/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/server/auth';
import { appDb, authDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export interface DeleteAccountState {
  status: 'idle' | 'error';
  message?: string;
}

/**
 * Deletes the signed-in account (§4.2, §20 #14). Needs the password and a typed
 * confirmation. Running strategies stop and their working orders are canceled,
 * the account is marked deleted and every session ends; the worker purges it
 * after 30 days, keeping order and audit records without personal details.
 */
export async function deleteAccount(
  _prev: DeleteAccountState,
  form: FormData,
): Promise<DeleteAccountState> {
  const tenant = await requireTenant();
  if (form.get('confirm') !== 'DELETE') {
    return { status: 'error', message: 'Type DELETE to confirm.' };
  }
  const password = form.get('password');
  if (typeof password !== 'string' || password.length === 0) {
    return { status: 'error', message: 'Enter your password.' };
  }
  const h = await headers();
  try {
    await auth().api.verifyPassword({ body: { password }, headers: h });
  } catch {
    return { status: 'error', message: 'That password is not correct.' };
  }

  await withTenant(appDb(), tenant, (tx) => prepareAccountDeletion(tx, tenant.userId));
  await authDb()
    .update(schema.users)
    .set({ deletedAt: new Date() })
    .where(eq(schema.users.id, tenant.userId));
  // End this session and clear its cookie, then every other device's.
  await auth()
    .api.signOut({ headers: h })
    .catch(() => undefined);
  await authDb().delete(schema.sessions).where(eq(schema.sessions.userId, tenant.userId));
  redirect('/sign-in?deleted=1');
}
