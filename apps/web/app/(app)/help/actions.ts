'use server';

import { and, eq, isNull, schema, sql, withTenant } from '@tm/db';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

/**
 * Records that the person dismissed the guide card or watched the guide to the
 * end (N248, ADR 0088), so Strategy Lab stops showing the card. The first time wins.
 */
export async function markGuideVideoDone(): Promise<void> {
  const tenant = await requireTenant();
  await withTenant(appDb(), tenant, (tx) =>
    tx
      .update(schema.profiles)
      .set({ guideVideoDoneAt: sql`now()` })
      .where(
        and(eq(schema.profiles.userId, tenant.userId), isNull(schema.profiles.guideVideoDoneAt)),
      ),
  );
}
