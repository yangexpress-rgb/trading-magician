import { pendingShareCount, withTenant } from '@tm/db';
import { Badge } from '@tm/ui';
import type { ReactNode } from 'react';
import { NavLink } from '@/components/nav-link';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

/** The Trading Strategy tab's three sections (N156); the URLs stay as they were. */
const SECTIONS = [
  { href: '/library', label: 'Library' },
  { href: '/strategy-lab', label: 'Lab' },
  { href: '/sharing', label: 'Sharing' },
] as const;

export default async function TradingStrategyLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  const pending = await withTenant(appDb(), tenant, (tx) => pendingShareCount(tx, tenant.userId));
  return (
    <>
      <nav aria-label="Trading Strategy" className="mb-6 overflow-x-auto border-b border-line">
        <ul className="flex gap-1">
          {SECTIONS.map((s) => (
            <li key={s.href}>
              <NavLink
                href={s.href}
                className="inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-ink-muted hover:text-ink"
                activeClassName="!border-accent font-semibold !text-ink"
              >
                {s.label}
                {s.href === '/sharing' && pending > 0 && (
                  <Badge tone="info" icon={false}>
                    {pending}
                    <span className="sr-only"> waiting for your answer</span>
                  </Badge>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </>
  );
}
