'use server';

import { eq, recordAudit, schema, sql, withTenant } from '@tm/db';
import { revalidatePath } from 'next/cache';
import { profileUpdateSchema } from '@/lib/profile';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export interface ProfileFormState {
  status: 'idle' | 'saved' | 'invalid';
  errors?: Partial<Record<'displayName' | 'timezone' | 'baseCurrency' | 'locale', string>>;
}

export async function updateProfile(
  _prev: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const tenant = await requireTenant();
  const parsed = profileUpdateSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const errors: ProfileFormState['errors'] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof NonNullable<ProfileFormState['errors']>;
      errors[key] ??= issue.message;
    }
    return { status: 'invalid', errors };
  }

  await withTenant(appDb(), tenant, async (tx) => {
    const [before] = await tx.select().from(schema.profiles);
    await tx
      .update(schema.profiles)
      .set({ ...parsed.data, rowVersion: sql`${schema.profiles.rowVersion} + 1` })
      .where(eq(schema.profiles.userId, tenant.userId));
    const changed = before
      ? (Object.keys(parsed.data) as (keyof typeof parsed.data)[]).filter(
          (k) => before[k] !== parsed.data[k],
        )
      : [];
    await recordAudit(tx, {
      userId: tenant.userId,
      actorType: 'user',
      action: 'profile.updated',
      resourceType: 'profile',
      resourceId: tenant.userId,
      context: { changedFields: changed },
    });
  });
  revalidatePath('/settings');
  return { status: 'saved' };
}
