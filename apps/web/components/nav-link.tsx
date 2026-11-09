'use client';

import { cx } from '@tm/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLink({
  href,
  children,
  className,
  activeClassName,
  exact = false,
  also,
}: {
  href: string;
  /** Active only on this exact path, not on paths below it. */
  exact?: boolean | undefined;
  /** Other paths (and the paths below them) that also mark this link current. */
  also?: readonly string[] | undefined;
  children: ReactNode;
  className?: string;
  activeClassName?: string;
}) {
  const pathname = usePathname();
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  const active =
    pathname === href || (!exact && pathname.startsWith(`${href}/`)) || (also ?? []).some(under);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cx(className, active && activeClassName)}
    >
      {children}
    </Link>
  );
}
