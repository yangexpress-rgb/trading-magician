'use client';

import { CONTEXT_INSTRUMENT_ID, INDEX_BADGE, isIndicatorOnlyClass } from '@tm/domain';
import { useState } from 'react';
import { useEditor } from './editor-context';
import { MiniSelect } from './fields';
import { SymbolLookup } from './symbol-lookup';

/** The last choice in every picker: type any symbol instead of adding it first (N190). */
const ANOTHER = '__another_symbol__';

/** What "This instrument" means in the current editor, for labels and help text. */
export function contextLabel(slotMode: 'none' | 'selection' | 'legs'): string {
  return slotMode === 'selection' ? 'Each selected instrument' : "This leg's instrument";
}

/**
 * Instrument picker shared by every expression and order row. With a
 * Selection group or per-leg conditions it also offers "This instrument"
 * (v1.2 items 1 and 2): the member or leg being evaluated or traded.
 *
 * Indices such as the VIX (v1.2 item 5) are offered to conditions with an
 * "Index — not tradable" badge, and left out of a leg's picker entirely.
 *
 * Any other US stock, ETF or index can be typed right here (N190, ADR 0069):
 * "Another stock, ETF or index…" opens a symbol box, so nothing has to be
 * added to a list first.
 */
export function InstrumentSelect({
  id,
  label = 'Instrument',
  value,
  error,
  onChange,
  format = (i) => `${i.symbol} · ${i.displayName}`,
  allowContext = true,
  tradableOnly = false,
}: {
  id: string;
  label?: string;
  value: string;
  error?: string | undefined;
  onChange: (instrumentId: string) => void;
  format?: (i: { symbol: string; displayName: string; assetClass: string }) => string;
  allowContext?: boolean;
  /** A leg's picker: indicator-only instruments are left out. */
  tradableOnly?: boolean;
}) {
  const { instruments: all, slotMode, addInstrument, editable } = useEditor();
  const [typing, setTyping] = useState(false);
  const canType = !!addInstrument && editable;
  const instruments = tradableOnly ? all.filter((i) => !isIndicatorOnlyClass(i.assetClass)) : all;
  const offerContext = allowContext && (slotMode !== 'none' || value === CONTEXT_INSTRUMENT_ID);
  const known =
    instruments.some((i) => i.id === value) || (offerContext && value === CONTEXT_INSTRUMENT_ID);
  return (
    <div className="min-w-0">
      <MiniSelect
        id={id}
        label={label}
        value={value}
        error={error}
        onChange={(e) => {
          if (e.target.value === ANOTHER) setTyping(true);
          else {
            setTyping(false);
            onChange(e.target.value);
          }
        }}
      >
        {!known && <option value={value}>Choose an instrument</option>}
        {offerContext && <option value={CONTEXT_INSTRUMENT_ID}>{contextLabel(slotMode)}</option>}
        {instruments.map((i) => (
          <option key={i.id} value={i.id}>
            {format(i)}
            {isIndicatorOnlyClass(i.assetClass) ? ` · ${INDEX_BADGE}` : ''}
          </option>
        ))}
        {canType && <option value={ANOTHER}>Another stock, ETF or index…</option>}
      </MiniSelect>
      {typing && canType && (
        <SymbolLookup
          id={`${id}-symbol`}
          autoFocus
          tradableOnly={tradableOnly}
          onPick={(found) => {
            setTyping(false);
            onChange(found.id);
          }}
          onCancel={() => setTyping(false)}
        />
      )}
    </div>
  );
}
