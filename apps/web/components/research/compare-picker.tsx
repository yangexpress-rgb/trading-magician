'use client';

import type { InstrumentOptionDto } from '@tm/contracts';
import { findIndexListing } from '@tm/domain';
import { Alert } from '@tm/ui';
import { useId, useState } from 'react';
import { CandidateList } from '@/components/strategy/candidate-list';
import { MAX_COMPARE } from '@/lib/chart-history';
import { useInstrumentLookup } from '@/components/strategy/use-instrument-lookup';
import { SERIES_BG, type ComparedSeries } from './price-chart';

/**
 * Picks other symbols to draw on the same price chart (N196), like
 * TradingView's Compare: a ticker the person already has is added at once,
 * any other is found through their data feed. Each shows as a chip in its
 * line colour, with a button to take it off.
 */
export function ComparePicker({
  instruments,
  mainId,
  compared,
  canSearchMarket,
  onAdd,
  onRemove,
  onFound,
}: {
  instruments: readonly InstrumentOptionDto[];
  mainId: string;
  compared: readonly ComparedSeries[];
  canSearchMarket: boolean;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  /** A symbol the search found and registered. */
  onFound: (instrument: InstrumentOptionDto) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const { lookup, error, find, reset, pending } = useInstrumentLookup((found) => {
    onFound(found);
    setQuery('');
  });
  const full = compared.length >= MAX_COMPARE;
  const taken = new Set([mainId, ...compared.map((c) => c.id)]);
  const searched = lookup && !pending ? lookup : null;

  function submit() {
    const q = query.trim();
    if (!q) return;
    setNote(null);
    const known = instruments.find((i) => i.symbol.toLowerCase() === q.toLowerCase());
    if (known) {
      if (taken.has(known.id)) setNote(`${known.symbol} is already on the chart.`);
      else {
        onAdd(known.id);
        setQuery('');
      }
      return;
    }
    if (canSearchMarket || findIndexListing(q)) void find(q);
    else
      setNote(`${q.toUpperCase()} is not in your list. Add an Alpaca data feed to search for it.`);
  }

  return (
    <div className="mb-4" data-testid="compare">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink-muted">Compare</span>
        <ul aria-label="Compared symbols" className="contents">
          {compared.map((c) => (
            <li
              key={c.id}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface-2 pr-1 pl-2 text-sm"
            >
              <span aria-hidden className={`inline-block h-0.5 w-3 rounded ${SERIES_BG[c.slot]}`} />
              <span className="font-semibold">{c.symbol}</span>
              {c.loading && <span className="text-xs text-ink-muted">loading…</span>}
              {c.error && (
                <span className="text-xs text-danger" title={c.error}>
                  no prices
                </span>
              )}
              <button
                type="button"
                aria-label={`Stop comparing ${c.symbol}`}
                onClick={() => onRemove(c.id)}
                className="rounded px-1 text-ink-muted hover:bg-surface hover:text-ink"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <form
          className="inline-flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor={`${id}-q`} className="sr-only">
            Add a symbol to compare
          </label>
          <input
            id={`${id}-q`}
            list={`${id}-known`}
            autoComplete="off"
            maxLength={60}
            disabled={full}
            placeholder={full ? `Up to ${MAX_COMPARE} symbols` : 'Add symbol, e.g. SPY'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setNote(null);
              reset();
            }}
            className="h-7 w-44 rounded-md border border-line bg-surface px-2 text-sm disabled:opacity-50"
          />
          <datalist id={`${id}-known`}>
            {instruments
              .filter((i) => !taken.has(i.id))
              .map((i) => (
                <option key={i.id} value={i.symbol}>
                  {i.displayName}
                </option>
              ))}
          </datalist>
          <button
            type="submit"
            disabled={full || !query.trim() || pending}
            className="h-7 rounded-md border border-line bg-surface-2 px-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? 'Searching…' : 'Add'}
          </button>
        </form>
      </div>
      {note && <p className="mt-1 text-sm text-ink-muted">{note}</p>}
      {searched?.status === 'not_found' && (
        <div className="mt-1 max-w-md">
          <p className="text-sm">{searched.message}</p>
          <CandidateList
            candidates={searched.candidates}
            disabled={pending}
            onPick={(symbol) => void find(symbol)}
          />
        </div>
      )}
      {(error || searched?.status === 'failed') && (
        <div className="mt-1">
          <Alert>{error ?? searched?.message}</Alert>
        </div>
      )}
    </div>
  );
}
