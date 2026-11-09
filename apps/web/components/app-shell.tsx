import {
  AdminIcon,
  Badge,
  ChartIcon,
  LabIcon,
  ModeBadge,
  OrdersIcon,
  ResearchIcon,
  SettingsIcon,
} from '@tm/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { NavLink } from './nav-link';
import { NotificationsLink } from './notifications-link';
import { SignOutButton } from './sign-out-button';

/**
 * Primary navigation, in the order fixed by Design v1.0 §5. Trading Strategy
 * holds the Strategy Library, Strategy Lab and Sharing as tabs (N156).
 */
interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  also?: readonly string[];
}

export const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/research', label: 'Quantitative Research', icon: <ResearchIcon /> },
  {
    href: '/strategy-lab',
    label: 'Trading Strategy',
    icon: <LabIcon />,
    also: ['/library', '/sharing'],
  },
  { href: '/orders', label: 'Orders', icon: <OrdersIcon /> },
  { href: '/performance', label: 'Performance', icon: <ChartIcon /> },
  { href: '/settings', label: 'Settings', icon: <SettingsIcon /> },
];

/** Shown only to admins (ADR 0037), after the primary tabs. */
const ADMIN_NAV: NavItem = { href: '/admin', label: 'Admin', icon: <AdminIcon /> };

export function AppShell({
  email,
  isAdmin = false,
  pendingShares = 0,
  children,
}: {
  email: string;
  isAdmin?: boolean;
  /** Shares waiting for the person's answer (ADR 0056). */
  pendingShares?: number;
  children: ReactNode;
}) {
  const nav: readonly NavItem[] = isAdmin ? [...PRIMARY_NAV, ADMIN_NAV] : PRIMARY_NAV;
  return (
    <div className="min-h-screen md:grid md:grid-cols-[232px_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:border-r md:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-4">
          <span className="font-semibold">Trading Magician</span>
          <ModeBadge mode="paper" />
        </div>
        <nav aria-label="Primary" className="overflow-x-auto px-2 pb-2 md:pb-0">
          <ul className="flex gap-1 md:flex-col">
            {nav.map((item) => (
              <li key={item.href}>
                <NavLink
                  href={item.href}
                  also={item.also}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
                  activeClassName="bg-surface-2 font-semibold !text-ink"
                >
                  {item.icon}
                  {item.label}
                  {item.label === 'Trading Strategy' && pendingShares > 0 && (
                    <Badge tone="info" icon={false}>
                      {pendingShares}
                      <span className="sr-only"> shares waiting for your answer</span>
                    </Badge>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex flex-wrap px-2 pb-2 md:flex-col">
          <NotificationsLink />
        </div>
        <div className="hidden px-4 py-4 text-xs text-ink-muted md:absolute md:bottom-0 md:block md:w-full">
          <p className="truncate" title={email}>
            {email}
          </p>
          <div className="mt-2">
            <SignOutButton />
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        <div className="flex justify-end px-4 pt-3 md:hidden">
          <SignOutButton />
        </div>
        <main id="main" className="px-4 py-6 md:px-8 md:py-8 2xl:px-12">
          {children}
        </main>
        <footer className="px-4 pb-8 text-xs text-ink-muted md:px-8 2xl:px-12">
          <p>
            Paper trading only: simulated orders, no real money. Back tests and paper results do not
            predict real results and are not financial advice (§16.4).
          </p>
          <p className="mt-1">
            <Link href="/terms">Terms</Link> · <Link href="/privacy">Privacy</Link>
          </p>
        </footer>
      </div>
    </div>
  );
}
