import { PageHeader } from '@tm/ui';
import type { ReactNode } from 'react';
import { NavLink } from '@/components/nav-link';

const SECTIONS = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/data-feeds', label: 'Data feeds' },
  { href: '/settings/accounts', label: 'Trading platforms and accounts' },
  { href: '/settings/billing', label: 'Subscription and billing' },
  { href: '/settings/security', label: 'Notifications and security' },
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" />
      <nav aria-label="Settings sections" className="mb-6 overflow-x-auto border-b border-line">
        <ul className="flex gap-1">
          {SECTIONS.map((s) => (
            <li key={s.href}>
              <NavLink
                href={s.href}
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
