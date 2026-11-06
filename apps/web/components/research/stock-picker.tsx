'use client';

import type { InstrumentOptionDto } from '@tm/contracts';
import { Alert, Button, Card, cx } from '@tm/ui';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { CandidateList } from '@/components/strategy/candidate-list';
import { useInstrumentLookup } from '@/components/strategy/use-instrument-lookup';
import { ASSET_CLASS_LABELS } from '@/lib/integration-text';

/**
 * Chooses what to chart (ADR 0029). One search box filters the stocks the
 * person already has (the demo instruments plus real ones they looked up or
 * use, ADR 0017) and, through their data feed, searches every US stock and
 * ETF by ticker or company name.
 */
export function StockPicker({
  instruments,
  selectedId,
  onSelect,
  onAdded,
  canSearchMarket,
}: {
  instruments: readonly InstrumentOptionDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** A stock the search found and registered. */
  onAdded: (instrument: InstrumentOptionDto) => void;
  /** The person has a data feed that can search US stocks, such as Alpaca. */
  canSearchMarket: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const { lookup, error, find, reset, pending } = useInstrumentLookup((found) => {
    onAdded(found);
    setQuery('');
  });
  const q = query.trim();

  const groups = useMemo(() => {
    const lower = q.toLowerCase();
    const match = (i: InstrumentOptionDto) =>
      !lower ||
      i.symbol.toLowerCase().includes(lower) ||
      i.displayName.toLowerCase().includes(lower);
    const shown = instruments.filter(match);
    return [
      { label: 'Your US stocks and ETFs', items: shown.filter((i) => i.venue !== 'DEMO') },
      { label: 'Demo instruments', items: shown.filter((i) => i.venue === 'DEMO') },
    ].filter((g) => g.items.length > 0);
  }, [instruments, q]);

  const searched = lookup && !pending ? lookup : null;

  return (
    <Card>
      <h2 className="text-lg font-semibold">Stocks</h2>
      <form
        role="search"
        aria-label="Stocks"
        onSubmit={(e) => {
          e.preventDefault();
          if (q && canSearchMarket) void find(q);
        }}
      >
        <label htmlFor={`${id}-q`} className="mt-2 block text-sm font-medium">
          Search by ticker or company name
        </label>
        <input
          id={`${id}-q`}
          type="search"
          autoComplete="off"
          maxLength={60}
          placeholder="e.g. COR or Cencora"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            reset();
          }}
          className="mt-1 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
        />
      </form>

      <div className="mt-3 max-h-[28rem] space-y-3 overflow-y-auto">
        {groups.map((g) => (
          <div key={g.label}>
            <h3 className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase">
              {g.label}
            </h3>
            <ul aria-label={g.label} className="space-y-0.5">
              {g.items.map((i) => {
                const on = i.id === selectedId;
                return (
                  <li key={i.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => onSelect(i.id)}
                      className={cx(
                        'flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm',
                        on ? 'bg-info-soft text-info' : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="shrink-0 font-semibold whitespace-nowrap">{i.symbol}</span>
                      <span className={cx('min-w-0 truncate', on ? '' : 'text-ink-muted')}>
                        {i.displayName}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-ink-muted">
                        {ASSET_CLASS_LABELS[i.assetClass] ?? i.assetClass}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        <section aria-labelledby={`${id}-all`}>
          <h3
            id={`${id}-all`}
            className="mb-1 text-xs font-semibold tracking-wide text-ink-muted uppercase"
          >
            All US stocks and ETFs
          </h3>
          {!canSearchMarket ? (
            <p className="text-sm text-ink-muted" data-testid="needs-feed">
              To search every US stock and ETF, add an Alpaca data feed with your paper API key in{' '}
              <Link href="/settings/data-feeds">Settings › Data feeds</Link>. Until then only stocks
              you already use can be charted.
            </p>
          ) : !q ? (
            <p className="text-sm text-ink-muted">
              Type a ticker or company name above to search your data feed.
            </p>
          ) : (
            <>
              {!searched && (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => void find(q)}
                  className="max-w-full"
                >
                  <span className="truncate">
                    {pending ? `Searching for “${q}”…` : `Search all US stocks for “${q}”`}
                  </span>
                </Button>
              )}
              <p role="status" aria-live="polite" className="sr-only">
                {pending ? `Searching for ${q}` : ''}
              </p>
              {searched?.status === 'not_found' && (
                <>
                  <p className="text-sm">{searched.message}</p>
                  <CandidateList
                    candidates={searched.candidates}
                    disabled={pending}
                    onPick={(symbol) => void find(symbol)}
                  />
                </>
              )}
              {(error || searched?.status === 'failed') && (
                <Alert>{error ?? searched?.message}</Alert>
              )}
            </>
          )}
        </section>
      </div>
    </Card>
  );
}
