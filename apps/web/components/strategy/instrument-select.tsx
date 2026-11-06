'use client';

import { CONTEXT_INSTRUMENT_ID } from '@tm/domain';
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
 */
export function InstrumentSelect({
  id,
  label = 'Instrument',
  value,
  error,
  onChange,
  format = (i) => `${i.symbol} · ${i.displayName}`,
  allowContext = true,
}: {
  id: string;
  label?: string;
  value: string;
  error?: string | undefined;
  onChange: (instrumentId: string) => void;
  format?: (i: { symbol: string; displayName: string; assetClass: string }) => string;
  allowContext?: boolean;
}) {
  const { instruments, slotMode } = useEditor();
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
        </option>
      ))}
    </MiniSelect>
  );
}
