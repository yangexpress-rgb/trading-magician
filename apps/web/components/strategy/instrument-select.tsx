'use client';

import { CONTEXT_INSTRUMENT_ID, INDEX_BADGE, isIndicatorOnlyClass } from '@tm/domain';
import { useEditor } from './editor-context';
import { MiniSelect } from './fields';

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
  const { instruments: all, slotMode } = useEditor();
  const instruments = tradableOnly ? all.filter((i) => !isIndicatorOnlyClass(i.assetClass)) : all;
  const offerContext = allowContext && (slotMode !== 'none' || value === CONTEXT_INSTRUMENT_ID);
  const known =
    instruments.some((i) => i.id === value) || (offerContext && value === CONTEXT_INSTRUMENT_ID);
  return (
    <MiniSelect
      id={id}
      label={label}
      value={value}
      error={error}
      onChange={(e) => onChange(e.target.value)}
    >
      {!known && <option value={value}>Choose an instrument</option>}
      {offerContext && <option value={CONTEXT_INSTRUMENT_ID}>{contextLabel(slotMode)}</option>}
      {instruments.map((i) => (
        <option key={i.id} value={i.id}>
          {format(i)}
          {isIndicatorOnlyClass(i.assetClass) ? ` · ${INDEX_BADGE}` : ''}
        </option>
      ))}
    </MiniSelect>
  );
}
