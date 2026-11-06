import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database } from './client';
import { accounts, sessions, users } from './schema';
import { withTenant } from './tenant';

/**
 * The operator resets someone's password by hand (ADR 0036). With EMAIL_VERIFICATION=off the app sends no
 * email, so "forgot password" is the operator's job: this replaces the
 * password hash, signs the person out everywhere, and audits it in their own
 * trail. `auth` is the tm_auth login, `app` the tm_app login.
 *
 * Returns null when no live account has that email.
 */
export async function resetPasswordAsOperator(
  auth: Database,
  app: Database,
  email: string,
  passwordHash: string,
): Promise<{ userId: string } | null> {
  const userId = await auth.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(sql`lower(${users.email})`, email.trim().toLowerCase()), isNull(users.deletedAt)),
      );
    if (!user) return null;
    const updated = await tx
      .update(accounts)
      .set({ password: passwordHash, updatedAt: new Date() })
      .where(and(eq(accounts.userId, user.id), eq(accounts.providerId, 'credential')))
      .returning({ id: accounts.id });
    if (updated.length === 0) return null;
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    return user.id;
  });
  if (!userId) return null;
  await withTenant(app, { userId }, (tx) =>
    recordAudit(tx, {
      userId,
      actorType: 'system',
      action: 'account.password_reset_by_operator',
      resourceType: 'user',
      resourceId: userId,
    }),
  );
  return { userId };
}
