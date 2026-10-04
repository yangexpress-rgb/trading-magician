import 'server-only';
import { provisionWorkspace, type TenantContext } from '@tm/db';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { auth } from './auth';
import { appDb } from './db';

export interface SessionTenant extends TenantContext {
  email: string;
  name: string;
  sessionId: string;
}

/**
 * Resolves the signed-in user from the server-side session and makes sure their
 * workspace exists. The tenant id never comes from client input (ADR 0003).
 */
export const requireTenant = cache(async (): Promise<SessionTenant> => {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const { user } = session;
  await provisionWorkspace(appDb(), { userId: user.id, displayName: user.name });
  return { userId: user.id, email: user.email, name: user.name, sessionId: session.session.id };
});
