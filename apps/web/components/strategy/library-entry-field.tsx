'use client';

import type { LibraryChoiceRequest, LibraryEntrySummaryDto } from '@tm/contracts';
import { Button } from '@tm/ui';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * The theory search used by the theory line under a strategy's name (N191).
 * A strategy refers to any theory, or to none (ADR 0072).
 */
export type LibraryPick =
  { kind: 'entry'; registrationNumber: string; name: string } | { kind: 'none' };

export const toChoiceRequest = (pick: LibraryPick): LibraryChoiceRequest =>
  pick.kind === 'entry'
    ? { kind: 'entry', registrationNumber: pick.registrationNumber }
    : { kind: 'none' };

export function EntrySearch({
  currentId,
  onPick,
  onClose,
  offerNone = false,
}: {
  currentId: string | undefined;
  /** True offers "No theory", to stop referring to the current one. */
  offerNone?: boolean;
  onPick: (pick: LibraryPick) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<LibraryEntrySummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      apiClient.library
        .list({ q: query.trim() || undefined, status: 'registered' })
        .then((r) => {
          if (live) {
            setItems(r.items);
            setError(null);
          }
        })
        .catch(() => live && setError('Could not load the Library. Try again.'));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    // Esc cancels the search and puts the display back as it was (N200).
    <div
      className="mt-3 rounded-md border border-line p-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <label htmlFor="library-entry-search" className="block text-sm font-semibold text-ink-muted">
        Search the Library by number or name
      </label>
      <input
        id="library-entry-search"
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="T00001-SD or a name"
        className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm" aria-label="Library entries">
        {offerNone && (
          <li>
            <button
              type="button"
              className="w-full rounded px-2 py-1 text-left hover:bg-surface-2"
              onClick={() => onPick({ kind: 'none' })}
            >
              <span className="font-semibold">No theory</span>{' '}
              <span className="text-ink-muted">— this strategy stops referring to one</span>
            </button>
          </li>
        )}
        {items === null && !error && <li className="px-2 text-ink-muted">Loading…</li>}
        {items?.length === 0 && <li className="px-2 text-ink-muted">No entry matches.</li>}
        {items?.map((e) => {
          const isCurrent = e.id === currentId;
          return (
            <li key={e.id}>
              <button
                type="button"
                disabled={isCurrent}
                className="w-full rounded px-2 py-1 text-left hover:bg-surface-2 disabled:opacity-60"
                onClick={() =>
                  onPick({ kind: 'entry', registrationNumber: e.registrationNumber, name: e.name })
                }
              >
                <span className="font-mono font-semibold">{e.registrationNumber}</span> {e.name}{' '}
                <span className="text-xs text-ink-muted">
                  {isCurrent
                    ? '(current theory)'
                    : e.builtStatus === 'built'
                      ? '· Built'
                      : '· Not built'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
