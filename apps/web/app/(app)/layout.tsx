import { pendingShareCount, withTenant } from '@tm/db';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { isAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  // Shares waiting for an answer (ADR 0056), counted beside Sharing.
  const pendingShares = await withTenant(appDb(), tenant, (tx) =>
    pendingShareCount(tx, tenant.userId),
  );
  return (
    <AppShell email={tenant.email} isAdmin={await isAdmin()} pendingShares={pendingShares}>
      {children}
    </AppShell>
  );
}
