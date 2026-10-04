import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireTenant } from '@/lib/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  return <AppShell email={tenant.email}>{children}</AppShell>;
}
