import { ChartIcon, LabIcon, ModeBadge, OrdersIcon, ResearchIcon, SettingsIcon } from '@tm/ui';
import type { ReactNode } from 'react';
import { NavLink } from './nav-link';
import { SignOutButton } from './sign-out-button';

/** Primary navigation, in the order fixed by Design v1.0 §5. */
export const PRIMARY_NAV = [
  { href: '/research', label: 'Quantitative Research', icon: <ResearchIcon /> },
  { href: '/strategy-lab', label: 'Strategy Lab', icon: <LabIcon /> },
  { href: '/orders', label: 'Orders', icon: <OrdersIcon /> },
  { href: '/performance', label: 'Performance', icon: <ChartIcon /> },
  { href: '/settings', label: 'Settings', icon: <SettingsIcon /> },
] as const;

export function AppShell({ email, children }: { email: string; children: ReactNode }) {
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
            {PRIMARY_NAV.map((item) => (
              <li key={item.href}>
                <NavLink
                  href={item.href}
                  className="flex items-center gap-3 rounded-md px-3 py-2 text-sm whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
                  activeClassName="bg-surface-2 font-semibold !text-ink"
                >
                  {item.icon}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
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
        <main id="main" className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
