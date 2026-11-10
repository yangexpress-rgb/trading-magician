'use client';

import { Card } from '@tm/ui';
import { useEffect, useState, type ReactNode } from 'react';

const KEY = (id: string) => `tm.research.open.${id}`;

/**
 * A section under the price chart (Options, Earnings, Company) that starts
 * closed (N202): its title opens it to show everything, and closes it again.
 * The header's short facts (next release, the data source) stay in sight.
 * Each browser remembers which sections the person left open.
 */
export function ResearchSection({
  id,
  title,
  extra,
  children,
}: {
  id: string;
  title: string;
  /** Shown beside the title whether open or closed. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY(id)) === '1') setOpen(true);
    } catch {
      // Storage may be blocked; the section just starts closed.
    }
  }, [id]);
  const toggle = () => {
    setOpen((was) => {
      try {
        window.localStorage.setItem(KEY(id), was ? '0' : '1');
      } catch {
        // Not remembered, still toggled.
      }
      return !was;
    });
  };
  return (
    <Card>
      <section aria-labelledby={`${id}-heading`}>
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id={`${id}-heading`} className="text-lg font-semibold">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={`${id}-body`}
              onClick={toggle}
              className="flex items-center gap-2 rounded text-left hover:text-accent"
            >
              <span
                aria-hidden
                className={`inline-block text-sm text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`}
              >
                ▸
              </span>
              {title}
            </button>
          </h2>
          {extra}
        </header>
        <div id={`${id}-body`} hidden={!open} className="mt-4 space-y-4">
          {children}
        </div>
      </section>
    </Card>
  );
}
