import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NavLink } from '@/components/nav-link';
import { requireAdmin } from '@/lib/server/admin';

export const metadata: Metadata = { title: 'Admin' };

const SECTIONS = [
  { href: '/admin', label: 'Overview', exact: true },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/invites', label: 'Invite codes' },
  { href: '/admin/audit', label: 'Audit log' },
];

/** The admin page (ADR 0037). Anyone who is not an admin gets a 404. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <>
      <PageHeader
        title="Admin"
        description="Testers, invite codes and system health. Every change here is audited."
      />
      <nav aria-label="Admin sections" className="mb-6 overflow-x-auto border-b border-line">
        <ul className="flex gap-1">
          {SECTIONS.map((s) => (
            <li key={s.href}>
              <NavLink
                href={s.href}
                exact={s.exact}
                className="block border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-ink-muted hover:text-ink"
                activeClassName="!border-accent font-semibold !text-ink"
              >
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </>
  );
}
