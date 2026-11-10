'use client';

import { cx } from '@tm/ui';
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * A compact row of filter pills (N195). Each filter is a small pill that opens
 * a popover; a choice applies the moment it is picked, so there is no Apply
 * button. A few filters are pinned as pills; the rest wait in the "Filter"
 * menu until asked for. Set filters show their value and an × to remove them.
 */

export interface FilterOption {
  value: string;
  label: string;
}

interface FilterBase {
  key: string;
  label: string;
  /** Shown as a pill even when not set. */
  pinned?: boolean;
  /** A short explanation shown in the popover. */
  hint?: ReactNode;
  disabled?: boolean;
  title?: string | undefined;
}

export interface ChoiceFilter extends FilterBase {
  kind: 'choice';
  options: readonly FilterOption[];
  value: string;
  /** The value meaning "not filtered"; '' unless said otherwise. */
  anyValue?: string;
  /**
   * A setting rather than a filter (such as the sort or the stock group): it
   * always shows its value, has no ×, and Clear leaves it alone.
   */
  setting?: boolean;
}

export interface RangeFilter extends FilterBase {
  kind: 'range';
  min: string;
  max: string;
  /** Whether a typed amount can't be read. */
  invalid?: (text: string) => boolean;
}

export type FilterDef = ChoiceFilter | RangeFilter;

export const isFilterSet = (f: FilterDef) =>
  f.kind === 'choice'
    ? !f.setting && f.value !== (f.anyValue ?? '')
    : f.min.trim() !== '' || f.max.trim() !== '';

const summary = (f: FilterDef): string | null => {
  if (f.kind === 'choice') {
    if (!f.setting && f.value === (f.anyValue ?? '')) return null;
    return f.options.find((o) => o.value === f.value)?.label ?? f.value;
  }
  const min = f.min.trim();
  const max = f.max.trim();
  if (min && max) return `${min} to ${max}`;
  if (min) return `≥ ${min}`;
  if (max) return `≤ ${max}`;
  return null;
};

export interface FilterBarProps {
  /** Names the toolbar for screen readers. */
  label: string;
  search?:
    | {
        label: string;
        value: string;
        placeholder?: string | undefined;
        onChange: (value: string) => void;
      }
    | undefined;
  /** Settings shown before the search box, such as the stock group. */
  leading?: FilterDef[];
  filters: FilterDef[];
  /** Settings shown after the filters, such as the sort. */
  trailing?: FilterDef[];
  onChoice: (key: string, value: string) => void;
  onRange?: (key: string, end: 'min' | 'max', text: string) => void;
  /** Takes one filter off; for a choice, back to its "any" value. */
  onRemove: (key: string) => void;
  onClear: () => void;
  /** Buttons at the far end of the row, such as Columns or Download CSV. */
  actions?: ReactNode;
}

export function FilterBar({
  label,
  search,
  leading = [],
  filters,
  trailing = [],
  onChoice,
  onRange,
  onRemove,
  onClear,
  actions,
}: FilterBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  /** Filters taken from the menu this visit, kept as pills while being set. */
  const [added, setAdded] = useState<string[]>([]);
  const set = filters.filter(isFilterSet).length;
  const shown = filters.filter((f) => f.pinned || isFilterSet(f) || added.includes(f.key));
  const hidden = filters.filter((f) => !shown.includes(f));

  const close = (key: string) => {
    setOpen((o) => (o === key ? null : o));
    // A filter added from the menu and left empty goes back to the menu.
    setAdded((a) => {
      const f = filters.find((x) => x.key === key);
      return f && !isFilterSet(f) ? a.filter((k) => k !== key) : a;
    });
  };

  const pill = (f: FilterDef) => (
    <FilterPill
      key={f.key}
      filter={f}
      open={open === f.key}
      onOpen={() => setOpen(f.key)}
      onClose={() => close(f.key)}
      onChoice={(v) => {
        onChoice(f.key, v);
        setOpen(null);
      }}
      onRange={(end, text) => onRange?.(f.key, end, text)}
      onRemove={() => {
        onRemove(f.key);
        setAdded((a) => a.filter((k) => k !== f.key));
        setOpen(null);
      }}
    />
  );

  return (
    <div role="toolbar" aria-label={label} className="flex flex-wrap items-center gap-2">
      {leading.map(pill)}
      {search && <SearchBox {...search} />}
      {shown.map(pill)}
      {hidden.length > 0 && (
        <PillMenu
          label={
            <>
              <span aria-hidden="true">+</span> Filter
            </>
          }
          menuLabel="Add a filter"
          dashed
          items={hidden.map((f) => ({ value: f.key, label: f.label }))}
          onPick={(key) => {
            setAdded((a) => [...a, key]);
            setOpen(key);
          }}
        />
      )}
      {set > 0 && (
        <button
          type="button"
          onClick={() => {
            onClear();
            setAdded([]);
            setOpen(null);
          }}
          className="h-8 rounded-full px-2 text-sm text-ink-muted hover:text-ink hover:underline"
        >
          Clear filters ({set})
        </button>
      )}
      {trailing.length > 0 && <span className="flex-1" />}
      {trailing.map(pill)}
      {actions && (
        <div className={cx('flex items-center gap-2', trailing.length === 0 && 'ml-auto')}>
          {actions}
        </div>
      )}
    </div>
  );
}

const pillBase =
  'inline-flex h-8 items-center gap-1 rounded-full border text-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60';

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" className="opacity-60">
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Whether a popover this wide would run off the right of the window from here. */
const runsOffRight = (el: HTMLElement | null, width: number) =>
  el !== null && el.getBoundingClientRect().left + width > window.innerWidth - 16;

/** Closes a popover on a click outside it or on Escape. */
function useDismiss(
  open: boolean,
  root: RefObject<HTMLElement | null>,
  onClose: () => void,
  returnFocus?: RefObject<HTMLElement | null>,
) {
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) latest.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      latest.current();
      returnFocus?.current?.focus();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, root, returnFocus]);
}

function FilterPill({
  filter: f,
  open,
  onOpen,
  onClose,
  onChoice,
  onRange,
  onRemove,
}: {
  filter: FilterDef;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChoice: (value: string) => void;
  onRange: (end: 'min' | 'max', text: string) => void;
  onRemove: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useDismiss(open, root, onClose, button);
  const [flip, setFlip] = useState(false);
  const value = summary(f);
  const setting = f.kind === 'choice' && f.setting;
  const on = value !== null && !setting;

  return (
    <div ref={root} className="relative">
      <div
        className={cx(
          pillBase,
          on
            ? 'border-accent bg-info-soft text-ink'
            : 'border-line bg-surface text-ink hover:bg-surface-2',
          f.disabled && 'opacity-60',
        )}
      >
        <button
          ref={button}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          disabled={f.disabled}
          title={f.title}
          onClick={() => {
            if (open) return onClose();
            setFlip(runsOffRight(root.current, 300));
            onOpen();
          }}
          className={cx(
            'inline-flex h-full items-center gap-1 rounded-full pl-3 disabled:cursor-not-allowed',
            on ? 'pr-1' : 'pr-2.5',
          )}
        >
          <span className={cx(value !== null && 'text-ink-muted')}>
            {f.label}
            {value !== null && ':'}
          </span>
          {value !== null && (
            <span className="max-w-[14rem] truncate font-semibold text-content">{value}</span>
          )}
          {!on && <Chevron />}
        </button>
        {on && (
          <button
            type="button"
            aria-label={`Remove the ${f.label} filter`}
            title="Remove"
            onClick={onRemove}
            className="mr-1 inline-flex size-6 items-center justify-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={f.label}
          className={cx(
            'absolute z-30 mt-1 min-w-[14rem] rounded-md border border-line bg-surface p-2 shadow-lg',
            flip ? 'right-0' : 'left-0',
          )}
        >
          {f.kind === 'choice' ? (
            <ChoiceList filter={f} onPick={onChoice} />
          ) : (
            <RangeFields filter={f} onChange={onRange} />
          )}
          {f.hint && <p className="mt-2 max-w-[18rem] px-1 text-xs text-ink-muted">{f.hint}</p>}
        </div>
      )}
    </div>
  );
}

function ChoiceList({ filter: f, onPick }: { filter: ChoiceFilter; onPick: (v: string) => void }) {
  const [find, setFind] = useState('');
  const long = f.options.length > 10;
  const shown = useMemo(() => {
    const t = find.trim().toLowerCase();
    return t ? f.options.filter((o) => o.label.toLowerCase().includes(t)) : f.options;
  }, [find, f.options]);
  const name = useId();
  return (
    <fieldset>
      <legend className="sr-only">{f.label}</legend>
      {long && (
        <input
          type="search"
          autoFocus
          aria-label={`Find a ${f.label.toLowerCase()}`}
          placeholder="Find…"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          className="mb-1 block w-full rounded border border-line bg-surface px-2 py-1 text-sm text-content placeholder:text-ink-muted"
        />
      )}
      <ul className="max-h-72 overflow-y-auto">
        {shown.map((o, i) => {
          const checked = o.value === f.value;
          return (
            <li key={o.value}>
              <label
                className={cx(
                  'flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2',
                  checked && 'font-semibold',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={o.value}
                  checked={checked}
                  autoFocus={
                    !long && (checked || (i === 0 && !f.options.some((x) => x.value === f.value)))
                  }
                  onChange={() => onPick(o.value)}
                  // Picking the current value again still closes the popover.
                  onClick={() => checked && onPick(o.value)}
                  className="accent-accent"
                />
                {o.label}
              </label>
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2 py-1 text-sm text-ink-muted">No match</li>}
      </ul>
    </fieldset>
  );
}

function RangeFields({
  filter: f,
  onChange,
}: {
  filter: RangeFilter;
  onChange: (end: 'min' | 'max', text: string) => void;
}) {
  const box = (end: 'min' | 'max') => {
    const value = end === 'min' ? f.min : f.max;
    const bad = value.trim() !== '' && (f.invalid?.(value) ?? false);
    return (
      <label className="block text-xs font-semibold text-ink-muted">
        {end === 'min' ? 'At least' : 'At most'}
        <input
          type="text"
          inputMode="decimal"
          autoFocus={end === 'min'}
          aria-label={`${f.label}, ${end === 'min' ? 'at least' : 'at most'}`}
          aria-invalid={bad}
          placeholder={end}
          value={value}
          onChange={(e) => onChange(end, e.target.value)}
          className="mt-0.5 block w-28 rounded border border-line bg-surface px-2 py-1 text-right text-sm font-normal tabular-nums text-content placeholder:text-ink-muted aria-[invalid=true]:border-danger"
        />
      </label>
    );
  };
  return (
    <div className="flex items-end gap-2">
      {box('min')}
      <span className="pb-1.5 text-ink-muted">–</span>
      {box('max')}
    </div>
  );
}

/** A pill that opens a short menu, such as "+ Filter" or a list of ready-made screens. */
export function PillMenu({
  label,
  menuLabel,
  items,
  onPick,
  dashed = false,
  align = 'left',
}: {
  label: ReactNode;
  menuLabel: string;
  items: readonly FilterOption[];
  onPick: (value: string) => void;
  dashed?: boolean;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [find, setFind] = useState('');
  useDismiss(open, root, () => setOpen(false), button);
  const [flip, setFlip] = useState(align === 'right');
  const t = find.trim().toLowerCase();
  const shown = t ? items.filter((f) => f.label.toLowerCase().includes(t)) : items;
  const long = items.length > 8;
  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={dashed ? menuLabel : undefined}
        onClick={() => {
          setFlip(align === 'right' || runsOffRight(root.current, 256));
          setOpen((o) => !o);
          setFind('');
        }}
        className={cx(
          pillBase,
          'border-line bg-surface px-3 hover:bg-surface-2',
          dashed ? 'border-dashed text-ink-muted hover:text-ink' : 'text-ink',
        )}
      >
        {label}
        {!dashed && <Chevron />}
      </button>
      {open && (
        <div
          className={cx(
            'absolute z-30 mt-1 w-64 rounded-md border border-line bg-surface p-1 shadow-lg',
            flip ? 'right-0' : 'left-0',
          )}
        >
          {long && (
            <input
              type="search"
              autoFocus
              aria-label={`Find in ${menuLabel.toLowerCase()}`}
              placeholder="Find…"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              className="mb-1 block w-full rounded border border-line bg-surface px-2 py-1 text-sm text-content placeholder:text-ink-muted"
            />
          )}
          <ul role="menu" aria-label={menuLabel} className="max-h-80 overflow-y-auto">
            {shown.map((f, i) => (
              <li key={f.value} role="none">
                <button
                  type="button"
                  role="menuitem"
                  autoFocus={!long && i === 0}
                  onClick={() => {
                    setOpen(false);
                    onPick(f.value);
                  }}
                  className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"
                >
                  {f.label}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-2 py-1 text-sm text-ink-muted">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function SearchBox({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">{label}</span>
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 text-ink-muted"
      >
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" />
      </svg>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-56 rounded-full border border-line bg-surface pr-3 pl-8 text-sm text-content placeholder:text-ink-muted"
      />
    </label>
  );
}
