'use client';

import type { InstrumentLookupDto } from '@tm/contracts';
import { ASSET_CLASS_LABELS } from '@/lib/integration-text';

/** The listings a name search offered; picking one adds it by its ticker. */
export function CandidateList({
  candidates,
  onPick,
  disabled,
}: {
  candidates: InstrumentLookupDto['candidates'];
  onPick: (symbol: string) => void;
  disabled?: boolean;
}) {
  if (candidates.length === 0) return null;
  return (
    <ul aria-label="Matching US stocks and ETFs" className="mt-2 space-y-0.5">
      {candidates.map((c) => (
        <li key={`${c.symbol}-${c.venue}`}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPick(c.symbol)}
            className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
          >
            <span className="shrink-0 font-semibold whitespace-nowrap">{c.symbol}</span>
            <span className="min-w-0 truncate text-ink-muted">{c.displayName}</span>
            <span className="ml-auto shrink-0 text-xs text-ink-muted">
              {ASSET_CLASS_LABELS[c.assetClass] ?? c.assetClass} · {c.venue}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
