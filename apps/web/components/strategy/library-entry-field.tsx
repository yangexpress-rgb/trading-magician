'use client';

import type {
  LibraryChoiceRequest,
  LibraryEntrySummaryDto,
  StrategyLibraryDto,
} from '@tm/contracts';
import { isFixtureName, NUMBER_PENDING_TEXT } from '@tm/domain';
import { Badge, Button, Card } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

/**
 * The builder's "Library entry" picker (ADR 0054, brief D2, D5, D7). Every
 * strategy is one Strategy Library record and shows that record's number,
 * read-only. The picker changes which record: an existing entry (its number
 * is used, nothing is issued) or a new record of the strategy's own. The
 * change is saved with the draft. There is no "no record" choice.
 */
export function LibraryEntryField({
  current,
  strategyName,
  choice,
  onChoose,
  editable,
}: {
  current: StrategyLibraryDto | null;
  strategyName: string;
  /** The pending change, saved with the draft; null keeps the current record. */
  choice: LibraryPick | null;
  onChoose: (choice: LibraryPick | null) => void;
  editable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const fixture = isFixtureName(strategyName);

  return (
    <Card aria-labelledby="library-entry-heading">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="library-entry-heading" className="text-lg font-semibold">
          Library entry
        </h2>
        {current ? (
          <p className="text-sm">
            <Link
              href={`/library/${current.registrationNumber}`}
              className="font-mono font-semibold"
            >
              {current.registrationNumber}
            </Link>{' '}
            <span className="text-ink-muted">{current.name}</span>
            {current.autoCreated && (
              <Badge tone="info" className="ml-2">
                Auto-created
              </Badge>
            )}
            {current.status === 'retired' && (
              <Badge tone="warn" className="ml-2">
                Retired
              </Badge>
            )}
          </p>
        ) : (
          <p className="text-sm text-ink-muted" id="library-number-pending">
            {fixture
              ? 'Test fixtures get no number. Pick an entry to give it one.'
              : NUMBER_PENDING_TEXT}
          </p>
        )}
        {editable && !open && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setOpen(true)}>
            Change entry
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        The strategy&apos;s number is its Theory Library entry&apos;s number. It never changes when
        you edit the strategy; edit the entry itself in the Library.
      </p>
      {choice && (
        <p className="mt-2 text-sm" role="status">
          <span className="font-semibold">On save:</span>{' '}
          {choice.kind === 'entry'
            ? `uses ${choice.registrationNumber} (${choice.name})`
            : 'gets a new Library record and the next number'}
          {current && `; ${current.registrationNumber} goes back to Not built`}.{' '}
          <button type="button" className="underline" onClick={() => onChoose(null)}>
            Keep {current ? current.registrationNumber : 'as is'}
          </button>
        </p>
      )}
      {open && (
        <EntrySearch
          currentId={current?.entryId}
          onPick={(pick) => {
            onChoose(pick);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

export type LibraryPick =
  { kind: 'entry'; registrationNumber: string; name: string } | { kind: 'new' };

export const toChoiceRequest = (pick: LibraryPick): LibraryChoiceRequest =>
  pick.kind === 'entry'
    ? { kind: 'entry', registrationNumber: pick.registrationNumber }
    : { kind: 'new' };

function EntrySearch({
  currentId,
  onPick,
  onClose,
}: {
  currentId: string | undefined;
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
    <div className="mt-3 rounded-md border border-line p-3">
      <label htmlFor="library-entry-search" className="block text-sm font-semibold text-ink-muted">
        Search the Library by number or name
      </label>
      <input
        id="library-entry-search"
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="S00001-SD or a name"
        className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
      />
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-sm" aria-label="Library entries">
        <li>
          <button
            type="button"
            className="w-full rounded px-2 py-1 text-left hover:bg-surface-2"
            onClick={() => onPick({ kind: 'new' })}
          >
            <span className="font-semibold">New Library record</span>{' '}
            <span className="text-ink-muted">— created on save with the next number</span>
          </button>
        </li>
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
                    ? '(this strategy)'
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
