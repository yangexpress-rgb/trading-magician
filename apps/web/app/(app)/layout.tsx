import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { isAdmin } from '@/lib/server/admin';
import { requireTenant } from '@/lib/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  return (
    <AppShell email={tenant.email} isAdmin={await isAdmin()}>
      {children}
    </AppShell>
  );
}
