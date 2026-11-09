'use client';

import type { InstrumentOptionDto } from '@tm/contracts';
import { isIndicatorOnlyClass } from '@tm/domain';
import { Button } from '@tm/ui';
import { useEffect, useRef, useState } from 'react';
import { CandidateList } from './candidate-list';
import { useEditor, type InstrumentOption } from './editor-context';
import { useInstrumentLookup } from './use-instrument-lookup';

/**
 * Type any US stock, ETF or index right where it is needed (N190, ADR 0069):
 * no list to maintain first. A symbol the editor already knows is picked at
 * once; anything else is looked up through the person's data feed, registered
 * by the worker (ADR 0017) and added to the editor's instruments.
 */
export function SymbolLookup({
  id,
  onPick,
  onCancel,
  tradableOnly = false,
  autoFocus = false,
  label = 'Symbol or company name',
  actionLabel = 'Use',
}: {
  id: string;
  onPick: (instrument: InstrumentOption) => void;
  onCancel?: () => void;
  /** A leg or a universe member: an index can't be traded (v1.2 item 5). */
  tradableOnly?: boolean;
  autoFocus?: boolean;
  label?: string;
  actionLabel?: string;
}) {
  const { instruments, addInstrument } = useEditor();
  const [text, setText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const accept = (found: InstrumentOption) => {
    addInstrument?.(found);
    if (tradableOnly && isIndicatorOnlyClass(found.assetClass)) {
      setNotice(
        `${found.symbol} is an index: conditions can watch it, but it can't be traded or held.`,
      );
      return;
    }
    setNotice(null);
    setText('');
    onPick(found);
  };
  const { lookup, error, find, reset, pending } = useInstrumentLookup(
    (found: InstrumentOptionDto) => accept(found),
  );

  const go = (raw: string) => {
    const q = raw.trim();
    if (!q) return;
    setNotice(null);
    const known = instruments.find(
      (i) => i.venue !== 'DEMO' && i.symbol.toUpperCase() === q.toUpperCase(),
    );
    if (known) {
      reset();
      accept(known);
      return;
    }
    void find(q);
  };

  const message =
    notice ??
    error ??
    (lookup?.status === 'not_found' || lookup?.status === 'failed' ? lookup.message : null);

  return (
    <div className="mt-1 rounded-md border border-line bg-surface-2 p-2">
      <label htmlFor={id} className="block text-xs font-semibold text-ink-muted">
        {label}
      </label>
      <div className="mt-0.5 flex flex-wrap items-center gap-1">
        <input
          ref={input}
          id={id}
          type="text"
          autoComplete="off"
          maxLength={60}
          placeholder="e.g. NVDA, SPY or Cencora"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setNotice(null);
            reset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              go(text);
            } else if (e.key === 'Escape' && onCancel) {
              e.preventDefault();
              onCancel();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm text-content"
        />
        <Button size="sm" disabled={pending || !text.trim()} onClick={() => go(text)}>
          {pending ? 'Looking up…' : actionLabel}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? `Looking up ${text.trim()}` : ''}
      </p>
      {message && <p className="mt-1 text-xs font-medium text-danger">{message}</p>}
      {lookup?.status === 'not_found' && (
        <CandidateList
          candidates={lookup.candidates}
          disabled={pending}
          onPick={(symbol) => {
            setText(symbol);
            void find(symbol);
          }}
        />
      )}
    </div>
  );
}
