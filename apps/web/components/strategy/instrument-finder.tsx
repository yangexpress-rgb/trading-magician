'use client';

import { ApiError, type InstrumentLookupDto, type InstrumentOptionDto } from '@tm/contracts';
import { Alert, Button, Card, TextField } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { ASSET_CLASS_LABELS } from '@/lib/integration-text';

const POLL_MS = 1000;
const GIVE_UP_MS = 30_000;

/**
 * Finds a real US stock or ETF by symbol (ADR 0017). The worker looks it up
 * through the person's data feed; once found it can be picked anywhere in the
 * editor.
 */
export function InstrumentFinder({
  instruments,
  onFound,
  editable,
  heading = 'US stocks and ETFs',
  intro,
  foundText = 'Pick it in any condition or order.',
  showList = true,
}: {
  instruments: readonly InstrumentOptionDto[];
  onFound: (instrument: InstrumentOptionDto) => void;
  editable: boolean;
  heading?: string;
  /** Replaces the strategy-editor wording above the form. */
  intro?: React.ReactNode;
  /** Follows "Added SYMBOL, Name." once a lookup succeeds. */
  foundText?: string;
  /** Lists the tenant's real instruments above the form. */
  showList?: boolean;
}) {
  const [symbol, setSymbol] = useState('');
  const [lookup, setLookup] = useState<InstrumentLookupDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const real = instruments.filter((i) => i.venue !== 'DEMO');

  async function find(e: React.FormEvent) {
    e.preventDefault();
    clearTimeout(timer.current);
    setError(null);
    try {
      const started = await apiClient.instruments.lookup({ symbol });
      setLookup(started);
      const deadline = Date.now() + GIVE_UP_MS;
      const poll = async (current: InstrumentLookupDto) => {
        if (current.status !== 'pending') {
          if (current.status === 'found' && current.instrument) {
            onFound(current.instrument);
            setSymbol('');
          }
          return;
        }
        if (Date.now() > deadline) {
          setError('The lookup is taking longer than expected. Try again in a minute.');
          setLookup(null);
          return;
        }
        timer.current = setTimeout(() => {
          void apiClient.instruments.getLookup(current.id).then(
            (next) => {
              setLookup(next);
              void poll(next);
            },
            () => setError('Could not check the lookup. Try again.'),
          );
        }, POLL_MS);
      };
      void poll(started);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the lookup.');
    }
  }

  const status =
    lookup?.status === 'pending'
      ? `Looking up ${lookup.symbol}…`
      : lookup?.status === 'found' && lookup.instrument
        ? `Added ${lookup.instrument.symbol}, ${lookup.instrument.displayName}. ${foundText}`
        : '';

  return (
    <Card>
      <h2 id="instruments-heading" className="text-lg font-semibold">
        {heading}
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        {intro ?? (
          <>
            Besides the demo instruments, a strategy can use any US stock or ETF your data feed can
            find. Feeds are set up in <Link href="/settings/data-feeds">Settings › Data feeds</Link>
            .
          </>
        )}
      </p>
      {showList && real.length > 0 && (
        <ul aria-label="Your US stocks and ETFs" className="mb-3 flex flex-wrap gap-2 text-sm">
          {real.map((i) => (
            <li key={i.id} className="rounded border border-line px-2 py-1">
              <span className="font-medium">{i.symbol}</span>{' '}
              <span className="text-ink-muted">
                {i.displayName} · {ASSET_CLASS_LABELS[i.assetClass] ?? i.assetClass} · {i.venue}
              </span>
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form onSubmit={(e) => void find(e)} className="flex flex-wrap items-end gap-2">
          <TextField
            name="instrument-symbol"
            label="Symbol"
            required
            maxLength={12}
            autoComplete="off"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
          <Button type="submit" disabled={lookup?.status === 'pending' || !symbol.trim()}>
            Find
          </Button>
        </form>
      )}
      <p role="status" aria-live="polite" className="mt-2 text-sm">
        {status}
      </p>
      {(error || lookup?.status === 'not_found' || lookup?.status === 'failed') && (
        <Alert>{error ?? lookup?.message}</Alert>
      )}
    </Card>
  );
}
