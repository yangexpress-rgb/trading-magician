'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { type ChoiceFilter, FilterBar } from './filter-bar';

const SEARCH_WAIT_MS = 300;

/**
 * The filter pills for a server-rendered list (N194): every change goes
 * straight into the address, so the list updates at once with no Apply button.
 */
export function UrlFilterBar({
  label,
  search,
  filters,
  trailing = [],
  keepOnClear = [],
  resets = {},
}: {
  label: string;
  search?: { param: string; label: string; placeholder?: string; value: string };
  filters: ChoiceFilter[];
  trailing?: ChoiceFilter[];
  /** Address parameters Clear keeps, such as the sort. */
  keepOnClear?: string[];
  /** Parameters dropped when another changes, such as the sort direction when the sort does. */
  resets?: Record<string, string[]>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  const go = (next: URLSearchParams) => {
    const q = next.toString();
    startTransition(() => router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false }));
  };
  const change = (key: string, value: string, anyValue = '') => {
    const next = new URLSearchParams(params.toString());
    if (value === anyValue) next.delete(key);
    else next.set(key, value);
    for (const r of resets[key] ?? []) next.delete(r);
    go(next);
  };

  // The search box types freely and updates the list after a short pause.
  const [text, setText] = useState(search?.value ?? '');
  const sent = useRef(search?.value ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // The address changed from elsewhere (Clear, back): show what it says.
    if (search && search.value !== sent.current) {
      sent.current = search.value;
      setText(search.value);
    }
  }, [search]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const all = [...filters, ...trailing];
  const find = (key: string) => all.find((f) => f.key === key);

  return (
    <FilterBar
      label={label}
      search={
        search && {
          label: search.label,
          placeholder: search.placeholder,
          value: text,
          onChange: (v) => {
            setText(v);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              sent.current = v.trim();
              change(search.param, v.trim());
            }, SEARCH_WAIT_MS);
          },
        }
      }
      filters={filters}
      trailing={trailing}
      onChoice={(key, value) => change(key, value, find(key)?.anyValue)}
      onRemove={(key) => change(key, find(key)?.anyValue ?? '', find(key)?.anyValue)}
      onClear={() => {
        clearTimeout(timer.current);
        const next = new URLSearchParams();
        for (const k of keepOnClear) {
          const v = params.get(k);
          if (v) next.set(k, v);
        }
        sent.current = '';
        setText('');
        go(next);
      }}
    />
  );
}
