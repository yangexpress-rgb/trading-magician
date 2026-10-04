import 'server-only';
import { schema, withTenant, type TenantContext } from '@tm/db';
import { cache } from 'react';
import { appDb } from './db';

export const getProfile = cache(async (tenant: TenantContext) => {
  const [profile] = await withTenant(appDb(), tenant, (tx) => tx.select().from(schema.profiles));
  if (!profile) throw new Error('Profile missing after provisioning');
  return profile;
});
