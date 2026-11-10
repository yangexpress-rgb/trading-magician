'use client';

import { Badge } from '@tm/ui';
import { usePathname } from 'next/navigation';
import { createContext, useContext, type ReactNode } from 'react';
import { NavLink } from '@/components/nav-link';

/**
 * The Trading Strategy tab's three sections (N156), styled like Quantitative
 * Research's tools (N194): the page title "Trading Strategy", then these tabs.
 * The URLs stay as they were.
 */
export const TRADING_SECTIONS = [
  { href: '/strategy-lab', label: 'Strategy Lab' },
  { href: '/library', label: 'Theory Library' },
  { href: '/sharing', label: 'Sharing' },
] as const;

/** Shares waiting for the member's answer, counted once by the layout. */
const PendingShares = createContext(0);

/**
 * Wraps every Trading Strategy page. A section's own page (the Lab, Library
 * or Sharing list) draws the "Trading Strategy" header and the tabs itself,
 * as Quantitative Research does; pages below a section (a strategy, a
 * theory, a share) keep the tabs above their own heading.
 */
export function TradingStrategyShell({
  pendingShares,
  children,
}: {
  pendingShares: number;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const sectionPage = TRADING_SECTIONS.some((s) => s.href === pathname);
  return (
    <PendingShares.Provider value={pendingShares}>
      {!sectionPage && <TradingStrategyNav />}
      {children}
    </PendingShares.Provider>
  );
}

/** The tabs under the "Trading Strategy" title. */
export function TradingStrategyNav() {
  const pending = useContext(PendingShares);
  return (
    <nav aria-label="Trading Strategy" className="mb-6 overflow-x-auto border-b border-line">
      <ul className="flex gap-1">
        {TRADING_SECTIONS.map((s) => (
          <li key={s.href}>
            <NavLink
              href={s.href}
              className="flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-ink-muted hover:text-ink"
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
  );
}
