'use client';

import type { InstrumentOptionDto } from '@tm/contracts';
import { Card, cx } from '@tm/ui';
import { useId, useMemo, useState } from 'react';
import { ASSET_CLASS_LABELS } from '@/lib/integration-text';

/**
 * The stocks and ETFs a person can chart: the demo instruments plus the real
 * ones they looked up or use in a strategy (ADR 0017), filtered as they type.
 */
export function StockPicker({
  instruments,
  selectedId,
  onSelect,
}: {
  instruments: readonly InstrumentOptionDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (i: InstrumentOptionDto) =>
      !q || i.symbol.toLowerCase().includes(q) || i.displayName.toLowerCase().includes(q);
    const shown = instruments.filter(match);
    return [
      { label: 'Your US stocks and ETFs', items: shown.filter((i) => i.venue !== 'DEMO') },
      { label: 'Demo instruments', items: shown.filter((i) => i.venue === 'DEMO') },
    ].filter((g) => g.items.length > 0);
  }, [instruments, query]);

  return (
    <Card>
      <h2 className="text-lg font-semibold" id={`${id}-heading`}>
        Stocks
      </h2>
      <label htmlFor={`${id}-q`} className="mt-2 block text-sm font-medium">
        Search
      </label>
      <input
        id={`${id}-q`}
        type="search"
        autoComplete="off"
        placeholder="Symbol or name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mt-1 h-10 w-full rounded-md border border-line bg-surface px-3 text-sm"
      />
      <div className="mt-3 max-h-[28rem] space-y-3 overflow-y-auto">
        {groups.length === 0 && (
          <p className="text-sm text-ink-muted">
            Nothing matches “{query.trim()}”. Find it by symbol below.
          </p>
        )}
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
      </div>
    </Card>
  );
}
