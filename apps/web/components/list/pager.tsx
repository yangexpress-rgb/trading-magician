import { buttonClasses, cx } from '@tm/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

/** Rows per page on long lists (N399). */
export const PAGE_SIZE = 50;

/** The page a 1-based `page` parameter asks for, or 1 when it is missing or malformed. */
export function pageFrom(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/** How many pages `total` rows fill, at least 1. */
export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * The page numbers to show: the first, the last and the ones around the
 * current page, with a gap (null) where pages are skipped.
 */
export function pageList(page: number, pages: number): (number | null)[] {
  const show = new Set([1, pages, page - 1, page, page + 1]);
  const out: (number | null)[] = [];
  let last = 0;
  for (let p = 1; p <= pages; p += 1) {
    if (!show.has(p)) continue;
    if (p - last === 2) out.push(p - 1);
    else if (p - last > 2) out.push(null);
    out.push(p);
    last = p;
  }
  return out;
}

/**
 * Numbered pages under a long list (N399): "Showing 51–64 of 64", then
 * Previous, the page numbers and Next. A server-rendered list passes
 * `hrefFor`, so every page is an address; a client list passes `onPage`.
 * Nothing shows when everything fits on one page.
 */
export function Pager({
  page,
  total,
  noun,
  size = PAGE_SIZE,
  hrefFor,
  onPage,
}: {
  /** The current page, from 1. */
  page: number;
  total: number;
  /** What the rows are, plural, such as "strategies". */
  noun: string;
  size?: number;
  hrefFor?: (page: number) => string;
  onPage?: (page: number) => void;
}) {
  const pages = pageCount(total, size);
  if (pages <= 1) return null;
  const first = (page - 1) * size + 1;
  const last = Math.min(page * size, total);

  const item = (target: number, label: ReactNode, opts: { current?: boolean; aria?: string }) => {
    const className = cx(
      buttonClasses(opts.current ? 'primary' : 'secondary', 'sm'),
      'min-w-8 justify-center tabular-nums no-underline',
    );
    if (opts.current) {
      return (
        <span aria-current="page" className={className}>
          {label}
        </span>
      );
    }
    if (hrefFor) {
      return (
        <Link href={hrefFor(target)} aria-label={opts.aria} className={className} scroll={false}>
          {label}
        </Link>
      );
    }
    return (
      <button
        type="button"
        aria-label={opts.aria}
        className={className}
        onClick={() => onPage?.(target)}
      >
        {label}
      </button>
    );
  };
  const disabled = (label: string) => (
    <span aria-disabled="true" className={cx(buttonClasses('secondary', 'sm'), 'opacity-40')}>
      {label}
    </span>
  );

  return (
    <nav
      aria-label={`Pages of ${noun}`}
      className="mt-3 flex flex-wrap items-center justify-between gap-2"
    >
      <p className="text-sm text-ink-muted tabular-nums">
        Showing {first}–{last} of {total} {noun}
      </p>
      <ul className="flex flex-wrap items-center gap-1">
        <li>{page > 1 ? item(page - 1, 'Previous', {}) : disabled('Previous')}</li>
        {pageList(page, pages).map((p, i) =>
          p === null ? (
            <li key={`gap-${i}`} aria-hidden className="px-1 text-ink-muted">
              …
            </li>
          ) : (
            <li key={p}>{item(p, p, { current: p === page, aria: `Page ${p}` })}</li>
          ),
        )}
        <li>{page < pages ? item(page + 1, 'Next', {}) : disabled('Next')}</li>
      </ul>
    </nav>
  );
}
