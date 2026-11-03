'use client';

import { cx } from '@tm/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TOOLS = [
  { href: '/research', label: 'Price charts' },
  { href: '/research/screener', label: 'Stock screener' },
];

/** The tools of Quantitative Research (§11), one page each. */
export function ResearchNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Tools" className="mb-6 overflow-x-auto border-b border-line">
      <ul className="flex gap-1">
        {TOOLS.map((t) => {
          const active = pathname === t.href;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'block border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-ink-muted hover:text-ink',
                  active && '!border-accent font-semibold !text-ink',
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
