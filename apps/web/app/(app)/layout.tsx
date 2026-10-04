import Link from 'next/link';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/sign-out-button';
import { requireTenant } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  return (
    <>
      <header className="app">
        <strong>Trading Magician</strong>
        <span className="badge" aria-label="Account mode: Paper">
          Paper
        </span>
        <nav aria-label="Primary">
          <Link href="/strategy-lab">Strategy Lab</Link>
          <Link href="/settings">Settings</Link>
        </nav>
        <span className="muted">{tenant.email}</span>
        <SignOutButton />
      </header>
      {children}
    </>
  );
}
