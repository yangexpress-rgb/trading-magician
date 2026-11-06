'use client';

import type { InstrumentOptionDto } from '@tm/contracts';
import { INDEX_BADGE, isIndicatorOnlyClass } from '@tm/domain';
import { Alert, Badge, Button, Card, TextField } from '@tm/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ASSET_CLASS_LABELS } from '@/lib/integration-text';
import { CandidateList } from './candidate-list';
import { useInstrumentLookup } from './use-instrument-lookup';

/**
 * Finds a real US stock or ETF by ticker or company name (ADR 0017, 0029).
 * The worker looks it up through the person's data feed; once found it can be
 * picked anywhere in the editor.
 */
export function InstrumentFinder({
  instruments,
  onFound,
  editable,
}: {
  instruments: readonly InstrumentOptionDto[];
  onFound: (instrument: InstrumentOptionDto) => void;
  editable: boolean;
}) {
  const [text, setText] = useState('');
  const { lookup, error, find, pending } = useInstrumentLookup((found) => {
    onFound(found);
    setText('');
  });

  const real = instruments.filter((i) => i.venue !== 'DEMO');

  const status = pending
    ? `Looking up ${lookup?.symbol ?? ''}…`
    : lookup?.status === 'found' && lookup.instrument
      ? `Added ${lookup.instrument.symbol}, ${lookup.instrument.displayName}. Pick it in any condition or order.`
      : '';

  return (
    <Card>
      <h2 id="instruments-heading" className="text-lg font-semibold">
        US stocks, ETFs and indices
      </h2>
      <p className="mb-3 text-sm text-ink-muted">
        A strategy can use any US stock or ETF your data feed can find. Indices such as the VIX
        (search &ldquo;VIX&rdquo;) can be watched in conditions but not traded; their daily history
        comes from the CBOE feed. Feeds are set up in{' '}
        <Link href="/settings/data-feeds">Settings › Data feeds</Link>.
      </p>
      {real.length > 0 && (
        <ul
          aria-label="Your US stocks, ETFs and indices"
          className="mb-3 flex flex-wrap gap-2 text-sm"
        >
          {real.map((i) => (
            <li key={i.id} className="rounded border border-line px-2 py-1">
              <span className="font-medium">{i.symbol}</span>{' '}
              <span className="text-ink-muted">
                {i.displayName} · {ASSET_CLASS_LABELS[i.assetClass] ?? i.assetClass} · {i.venue}
              </span>
              {isIndicatorOnlyClass(i.assetClass) && <IndexBadge />}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void find(text);
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <TextField
            name="instrument-symbol"
            label="Symbol or company name"
            required
            maxLength={60}
            autoComplete="off"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit" disabled={pending || !text.trim()}>
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
      {editable && lookup?.status === 'not_found' && (
        <CandidateList
          candidates={lookup.candidates}
          disabled={pending}
          onPick={(symbol) => void find(symbol)}
        />
      )}
    </Card>
  );
}

/** Marks an indicator-only instrument wherever it appears (v1.2 item 5). */
export function IndexBadge() {
  return (
    <Badge tone="warn" className="ml-1">
      {INDEX_BADGE}
    </Badge>
  );
}
