'use client';

import { cx } from '@tm/ui';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChoiceList, RangeFields, type ChoiceFilter, type RangeFilter } from './filter-bar';

/** A column filtered by typed text ("contains"). */
export interface TextFilter {
  kind: 'text';
  key: string;
  label: string;
  value: string;
  placeholder?: string;
}

export type HeaderFilterDef = ChoiceFilter | RangeFilter | TextFilter;

export const isHeaderFilterSet = (f: HeaderFilterDef) =>
  f.kind === 'text'
    ? f.value.trim() !== ''
    : f.kind === 'choice'
      ? f.value !== (f.anyValue ?? '')
      : f.min.trim() !== '' || f.max.trim() !== '';

const PANEL_WIDTH = 240;

/**
 * A funnel beside a column header's label that filters the rows by that column
 * (N304). It opens a small panel: a box to type in, a list to pick from, or an
 * at least / at most pair. Choices apply at once; the funnel fills while set.
 * The panel sits over the page, so a table that scrolls sideways doesn't cut it off.
 */
export function HeaderFilter({
  filter: f,
  onText,
  onChoice,
  onRange,
  onClear,
}: {
  filter: HeaderFilterDef;
  onText?: (value: string) => void;
  onChoice?: (value: string) => void;
  onRange?: (end: 'min' | 'max', text: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const on = isHeaderFilterSet(f);

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 8));
    setPos({ top: r.bottom + 4, left });
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || button.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    // The panel is fixed to the window, so it follows its header on scroll.
    const move = () => place();
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', move, true);
    window.addEventListener('resize', move);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', move, true);
      window.removeEventListener('resize', move);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`Filter by ${f.label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-pressed={on}
        title={on ? `Filtered by ${f.label}` : `Filter by ${f.label}`}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-surface hover:text-ink',
          on ? 'text-accent' : 'opacity-50 hover:opacity-100',
        )}
      >
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path
            d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"
            fill={on ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-label={`Filter by ${f.label}`}
            style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
            // Normal case and weight: the panel is not part of the header's text.
            className="fixed z-40 rounded-md border border-line bg-surface p-2 text-left text-sm font-normal tracking-normal text-ink normal-case shadow-lg"
          >
            {f.kind === 'text' ? (
              <label className="block text-xs font-semibold text-ink-muted">
                Contains
                <input
                  type="search"
                  autoFocus
                  value={f.value}
                  placeholder={f.placeholder}
                  onChange={(e) => onText?.(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && setOpen(false)}
                  className="mt-0.5 block w-full rounded border border-line bg-surface px-2 py-1 text-sm font-normal text-content placeholder:text-ink-muted"
                />
              </label>
            ) : f.kind === 'choice' ? (
              <ChoiceList
                filter={f}
                onPick={(v) => {
                  onChoice?.(v);
                  setOpen(false);
                }}
              />
            ) : (
              <RangeFields filter={f} onChange={(end, text) => onRange?.(end, text)} />
            )}
            {f.kind === 'range' && f.hint && (
              <p className="mt-2 px-1 text-xs text-ink-muted">{f.hint}</p>
            )}
            {on && (
              <button
                type="button"
                onClick={() => {
                  onClear();
                  setOpen(false);
                  button.current?.focus();
                }}
                className="mt-2 rounded px-1 text-xs text-ink-muted hover:text-ink hover:underline"
              >
                Clear this filter
              </button>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
