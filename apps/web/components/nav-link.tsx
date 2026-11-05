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
}: {
  href: string;
  children: ReactNode;
  className?: string;
  activeClassName?: string;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
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
