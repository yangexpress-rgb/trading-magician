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
}: {
  href: string;
  /** Active only on this exact path, not on paths below it. */
  exact?: boolean | undefined;
  children: ReactNode;
  className?: string;
  activeClassName?: string;
}) {
  const pathname = usePathname();
  const active = pathname === href || (!exact && pathname.startsWith(`${href}/`));
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
