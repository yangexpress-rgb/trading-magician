'use client';

import type { ShareSourceDto } from '@tm/contracts';
import { Button } from '@tm/ui';
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { ShareDialog, type ShareItem } from './share-button';

/** What one send can carry (packages/db SHARE_MAX_SOURCES, N125). */
export const MAX_SHARE_ITEMS = 20;

const keyOf = (s: ShareSourceDto) =>
  s.kind === 'library' ? `library:${s.number}` : `lab:${s.strategyId}`;

interface Selection {
  selected: Map<string, ShareItem>;
  set: (items: ShareItem[], on: boolean) => void;
}

const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('Share selection controls must sit inside <ShareSelection>');
  return ctx;
}

/**
 * Lets a list pick several Library records or strategies and share them in one
 * send (ADR 0056, N125). Wrap the list; put a <ShareSelectedBar> above it and
 * a <ShareCheckbox> on each row that can be shared.
 */
export function ShareSelection({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Map<string, ShareItem>>(() => new Map());
  const value = useMemo<Selection>(
    () => ({
      selected,
      set: (items, on) =>
        setSelected((prev) => {
          const next = new Map(prev);
          for (const item of items) {
            const k = keyOf(item.source);
            if (!on) next.delete(k);
            else if (next.size < MAX_SHARE_ITEMS) next.set(k, item);
          }
          return next;
        }),
    }),
    [selected],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** "Share selected (3)" and Clear, with the share dialog for the picked items. */
export function ShareSelectedBar({
  isAdmin = false,
  noun,
}: {
  isAdmin?: boolean;
  /** "strategies" or "records". */
  noun: string;
}) {
  const { selected, set } = useSelection();
  const [sending, setSending] = useState<ShareItem[] | null>(null);
  const count = selected.size;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={count > 0 ? 'primary' : 'secondary'}
        disabled={count === 0}
        onClick={() => setSending([...selected.values()])}
      >
        {count > 0 ? `Share selected (${count})` : 'Share selected'}
      </Button>
      {count > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => set([...selected.values()], false)}>
          Clear selection
        </Button>
      ) : (
        <span className="text-xs text-ink-muted">
          Tick {noun} to share several at once (up to {MAX_SHARE_ITEMS}).
        </span>
      )}
      {count >= MAX_SHARE_ITEMS && (
        <span className="text-xs text-ink-muted">That’s the most one share can carry.</span>
      )}
      <ShareDialog
        open={sending !== null}
        onClose={() => setSending(null)}
        items={sending ?? []}
        isAdmin={isAdmin}
        onSent={() => set(sending ?? [], false)}
      />
    </div>
  );
}

/** A row's tick box. */
export function ShareCheckbox({ item }: { item: ShareItem }) {
  const { selected, set } = useSelection();
  const checked = selected.has(keyOf(item.source));
  const full = !checked && selected.size >= MAX_SHARE_ITEMS;
  return (
    <input
      type="checkbox"
      aria-label={`Select ${item.label} to share`}
      checked={checked}
      disabled={full}
      title={full ? `Up to ${MAX_SHARE_ITEMS} at a time` : undefined}
      onChange={(e) => set([item], e.target.checked)}
      className="h-4 w-4"
    />
  );
}

/** The header tick box: every shareable row on this page (up to the limit). */
export function ShareCheckAll({ items, noun }: { items: ShareItem[]; noun: string }) {
  const { selected, set } = useSelection();
  if (items.length === 0) return null;
  const all = items.every((i) => selected.has(keyOf(i.source)));
  return (
    <input
      type="checkbox"
      aria-label={all ? `Clear the ${noun} on this page` : `Select the ${noun} on this page`}
      checked={all}
      onChange={(e) => set(items, e.target.checked)}
      className="h-4 w-4"
    />
  );
}
