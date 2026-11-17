'use client';

import { INDEX_BADGE } from '@tm/domain';
import { Alert, Button, Card, cx } from '@tm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  addWatchSymbol,
  createWatchGroup,
  deleteWatchListGroup,
  foldWatchGroup,
  moveWatchListGroup,
  moveWatchSymbol,
  removeWatchSymbol,
  renameWatchListGroup,
  type WatchActionResult,
} from '@/app/(app)/research/watch-list/actions';
import { Signed } from '@/components/signed';
import { CandidateList } from '@/components/strategy/candidate-list';
import { useInstrumentLookup } from '@/components/strategy/use-instrument-lookup';
import {
  changedFrom,
  formatWatchChange,
  formatWatchLast,
  formatWatchPct,
  nextWatchSort,
  parseWatchSort,
  shownWatchRow,
  sortWatchRows,
  symbolHue,
  WATCH_POLL_MS,
  type WatchGroupDto,
  type WatchListDto,
  type WatchRowDto,
  type WatchSort,
  type WatchSortKey,
} from '@/lib/watch-list';

type Act = (change: Promise<WatchActionResult>) => Promise<boolean>;

const SORT_STORAGE = 'tm.watchList.sort';

/**
 * The watch list (N292, ADR 0101): named sections of symbols, each row's
 * last price and change since the previous close, refreshed every few
 * seconds while the page is open. Each section adds symbols from its own "+"
 * and every column header sorts (N293). Gains green, losses red, signs kept
 * with their figures (N289).
 */
export function WatchList({
  initial,
  canSearchMarket,
}: {
  initial: WatchListDto;
  canSearchMarket: boolean;
}) {
  const [list, setList] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [naming, setNaming] = useState(false);
  const [sort, setSort] = useState<WatchSort | null>(null);
  // Regular session by default; the Ext hours button adds pre-market and after-hours trades (N298).
  const [extended, setExtended] = useState(false);

  // The chosen sort is remembered in this browser.
  useEffect(() => {
    try {
      setSort(parseWatchSort(window.localStorage.getItem(SORT_STORAGE)));
    } catch {
      // Storage blocked: the saved order it is.
    }
  }, []);
  const sortBy = (key: WatchSortKey) => {
    const next = nextWatchSort(sort, key);
    setSort(next);
    try {
      if (next) window.localStorage.setItem(SORT_STORAGE, `${next.key}.${next.dir}`);
      else window.localStorage.removeItem(SORT_STORAGE);
    } catch {
      // Not remembered; it still applies on this page.
    }
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/research/watch-list', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setList((await res.json()) as WatchListDto);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (document.visibilityState === 'visible') await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), WATCH_POLL_MS);
    };
    timer = setTimeout(() => void tick(), WATCH_POLL_MS);
    const onShow = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [refresh]);

  /** Runs a change, then shows the list as saved. */
  const act: Act = useCallback(
    async (change) => {
      const result = await change;
      setError(result.ok ? null : (result.message ?? 'That did not save. Try again.'));
      await refresh();
      return result.ok;
    },
    [refresh],
  );

  const fold = (group: WatchGroupDto) => {
    const collapsed = !group.collapsed;
    setList((l) => ({
      ...l,
      groups: l.groups.map((g) => (g.id === group.id ? { ...g, collapsed } : g)),
    }));
    void act(foldWatchGroup(group.id, collapsed));
  };

  return (
    <div className="space-y-4">
      {!canSearchMarket && (
        <Alert>
          Prices need a US stock price feed. Add an Alpaca data feed with your paper API key in{' '}
          <Link href="/settings/data-feeds">Settings › Data feeds</Link>.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {list.groups.length === 0 && (
        <Card>
          <p className="text-sm text-ink-muted">
            Your watch list is empty. Add a section, then add symbols to it with its +.
          </p>
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {naming ? (
          <NameInput
            label="New section name"
            initial=""
            onCancel={() => setNaming(false)}
            onSave={async (name) => {
              if (await act(createWatchGroup(name))) setNaming(false);
            }}
          />
        ) : (
          <Button size="sm" onClick={() => setNaming(true)}>
            + New section
          </Button>
        )}
        <Button
          size="sm"
          variant={extended ? 'primary' : 'secondary'}
          aria-pressed={extended}
          onClick={() => setExtended((e) => !e)}
          title="Show pre-market and after-hours trades"
        >
          Ext hours
        </Button>
        <span className="text-xs text-ink-muted">
          {extended
            ? 'Showing extended hours: Pre and Post prices are measured from the regular close.'
            : 'Showing the regular session (9:30 AM to 4 PM New York).'}
        </span>
      </div>
      {/* Side by side as the screen allows (N294): as many ~30rem columns as fit, one on a phone. */}
      <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,30rem),1fr))]">
        {list.groups.map((g, gi) => (
          <Section
            key={g.id}
            group={g}
            first={gi === 0}
            last={gi === list.groups.length - 1}
            sort={sort}
            extended={extended}
            onSort={sortBy}
            onFold={() => fold(g)}
            canSearchMarket={canSearchMarket}
            act={act}
          />
        ))}
      </div>
      <p className="max-w-4xl text-xs text-ink-muted" role="status" aria-live="off">
        {offline
          ? 'Prices are not updating: the app cannot be reached. Retrying…'
          : `Updated ${new Date(list.asOf).toLocaleTimeString('en-US')}. Prices refresh every few seconds while US stocks trade (4 AM to 8 PM New York), once a minute otherwise.`}{' '}
        Chg and Chg% compare the regular session with the close before it; with Ext hours on, Pre
        and Post prices are compared with the latest regular close. Alpaca’s free feed has IEX
        exchange trades only. Indices are followed through the ETFs that track them (SPY, QQQ, DIA,
        IWM), so their Chg% moves with the index. D marks a daily close, such as the VIX from Cboe’s
        end-of-day history.
      </p>
    </div>
  );
}

/** Fixed widths, so every section's columns line up. */
const COLUMNS: { key: WatchSortKey; label: string; numeric: boolean; width: string }[] = [
  { key: 'symbol', label: 'Symbol', numeric: false, width: '' },
  { key: 'last', label: 'Last', numeric: true, width: 'w-20 sm:w-28' },
  { key: 'change', label: 'Chg', numeric: true, width: 'w-[4.5rem] sm:w-24' },
  { key: 'changePct', label: 'Chg%', numeric: true, width: 'w-[4.5rem] sm:w-24' },
];

/** One named section: its own header with fold, "+" and actions, and its own table. */
function Section({
  group,
  first,
  last,
  sort,
  extended,
  onSort,
  onFold,
  canSearchMarket,
  act,
}: {
  group: WatchGroupDto;
  first: boolean;
  last: boolean;
  sort: WatchSort | null;
  extended: boolean;
  onSort: (key: WatchSortKey) => void;
  onFold: () => void;
  canSearchMarket: boolean;
  act: Act;
}) {
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const bodyId = useId();
  const rows = sortWatchRows(
    group.rows.map((r) => shownWatchRow(r, extended)),
    sort,
  );
  return (
    <Card className="!p-0" aria-label={group.name}>
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        {renaming ? (
          <NameInput
            label="Section name"
            initial={group.name}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              if (await act(renameWatchListGroup(group.id, name))) setRenaming(false);
            }}
          />
        ) : (
          <>
            <button
              type="button"
              aria-expanded={!group.collapsed}
              aria-controls={bodyId}
              onClick={onFold}
              aria-label={`${group.collapsed ? 'Open' : 'Close'} ${group.name}`}
              className="flex size-7 items-center justify-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <Chevron open={!group.collapsed} />
            </button>
            <h2
              className="min-w-0 flex-1 cursor-text truncate text-base font-semibold"
              title="Double-click to rename"
              onDoubleClick={() => setRenaming(true)}
            >
              {group.name}
              <span className="ml-2 text-sm font-normal text-ink-muted">{group.rows.length}</span>
            </h2>
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label={`Add a symbol to ${group.name}`}
            aria-expanded={adding}
            title="Add a symbol"
            onClick={() => setAdding((a) => !a)}
            className={cx(
              'flex size-7 items-center justify-center rounded text-lg leading-none hover:bg-surface-2',
              adding ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            <span aria-hidden>+</span>
          </button>
          <RowMenu label={`${group.name} section actions`}>
            {(close) => (
              <>
                <MenuItem onClick={() => (close(), setRenaming(true))}>Rename</MenuItem>
                {!first && (
                  <MenuItem onClick={() => (close(), void act(moveWatchListGroup(group.id, -1)))}>
                    Move up
                  </MenuItem>
                )}
                {!last && (
                  <MenuItem onClick={() => (close(), void act(moveWatchListGroup(group.id, 1)))}>
                    Move down
                  </MenuItem>
                )}
                <MenuItem
                  danger
                  onClick={() => (close(), void act(deleteWatchListGroup(group.id)))}
                >
                  Delete section
                </MenuItem>
              </>
            )}
          </RowMenu>
        </div>
      </header>
      {adding && (
        <AddSymbol
          groupId={group.id}
          groupName={group.name}
          canSearchMarket={canSearchMarket}
          onAdd={(input) => act(addWatchSymbol(input))}
          onDone={() => setAdding(false)}
        />
      )}
      {!group.collapsed && (
        <div id={bodyId}>
          {group.rows.length === 0 ? (
            <p className="px-4 py-3 text-sm text-ink-muted">No symbols yet. Use + to add one.</p>
          ) : (
            <table aria-label={`${group.name} symbols`} className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-line text-ink-muted">
                  {COLUMNS.map((c) => {
                    const on = sort?.key === c.key;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                        className={cx(
                          'py-1.5 font-semibold',
                          c.width,
                          c.numeric ? 'px-2 text-right' : 'pr-2 pl-4 text-left',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => onSort(c.key)}
                          title={
                            !on
                              ? `Sort by ${c.label}, low to high`
                              : sort.dir === 'asc'
                                ? `Sort by ${c.label}, high to low`
                                : 'Back to your order'
                          }
                          className={cx(
                            'inline-flex items-center gap-1 rounded hover:text-ink',
                            c.numeric && 'flex-row-reverse',
                            on && 'text-ink',
                          )}
                        >
                          {c.label}
                          <SortMark dir={on ? sort.dir : null} />
                        </button>
                      </th>
                    );
                  })}
                  <th scope="col" className="w-10 py-1.5 pr-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <WatchRow
                    key={r.id}
                    row={r}
                    first={sort ? true : i === 0}
                    last={sort ? true : i === rows.length - 1}
                    extended={extended}
                    act={act}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}

function SortMark({ dir }: { dir: 'asc' | 'desc' | null }) {
  return (
    <span aria-hidden className={cx('w-2.5 text-[0.65rem]', !dir && 'opacity-30')}>
      {dir === 'desc' ? '▼' : dir === 'asc' ? '▲' : '↕'}
    </span>
  );
}

function WatchRow({
  row,
  first,
  last,
  extended,
  act,
}: {
  row: WatchRowDto;
  first: boolean;
  last: boolean;
  extended: boolean;
  act: Act;
}) {
  const phase = extended && row.ext ? row.ext.phase : null;
  const kind = row.daily
    ? 'Daily close of'
    : phase === 'pre'
      ? 'Pre-market trade'
      : phase === 'post'
        ? 'After-hours trade'
        : 'Regular session price';
  const priced = row.priceAt
    ? `${kind} ${new Date(row.priceAt).toLocaleString('en-US')}`
    : 'No price yet';
  return (
    <tr className="border-b border-line/60 last:border-b-0 hover:bg-surface-2">
      <td className="py-2 pr-2 pl-4">
        <SymbolCell row={row} />
      </td>
      <td className="px-2 py-2 text-right whitespace-nowrap" title={priced}>
        {phase && (
          <span
            className="mr-1.5 rounded bg-surface-2 px-1 py-px align-middle text-[0.65rem] font-semibold text-ink-muted uppercase"
            aria-label={phase === 'pre' ? 'pre-market' : 'after hours'}
          >
            {phase === 'pre' ? 'Pre' : 'Post'}
          </span>
        )}
        <LastPrice row={row} />
      </td>
      <td className="px-2 py-2 text-right text-content whitespace-nowrap">
        <Signed value={row.change}>{formatWatchChange(row.change, row.isIndex, row.last)}</Signed>
      </td>
      <td className="px-2 py-2 text-right text-content whitespace-nowrap">
        <Signed value={row.changePct}>{formatWatchPct(row.changePct)}</Signed>
      </td>
      <td className="py-2 pr-2 text-right">
        <RowMenu label={`${row.symbol} actions`}>
          {(close) => (
            <>
              {!first && (
                <MenuItem onClick={() => (close(), void act(moveWatchSymbol(row.id, -1)))}>
                  Move up
                </MenuItem>
              )}
              {!last && (
                <MenuItem onClick={() => (close(), void act(moveWatchSymbol(row.id, 1)))}>
                  Move down
                </MenuItem>
              )}
              <MenuItem danger onClick={() => (close(), void act(removeWatchSymbol(row.id)))}>
                Remove {row.symbol}
              </MenuItem>
            </>
          )}
        </RowMenu>
      </td>
    </tr>
  );
}

/** The symbol, its badge, and a link to its chart (looked up first when not yet registered). */
function SymbolCell({ row }: { row: WatchRowDto }) {
  const router = useRouter();
  const { find, pending, error } = useInstrumentLookup((instrument) =>
    router.push(`/research?instrument=${encodeURIComponent(instrument.id)}`),
  );
  const label = (
    <>
      <span
        aria-hidden
        className="hidden size-7 shrink-0 items-center justify-center rounded-full sm:flex text-[0.65rem] font-bold text-white"
        style={{ backgroundColor: `hsl(${symbolHue(row.symbol)} 45% 30%)` }}
      >
        {row.symbol.slice(0, 2)}
      </span>
      <span className="font-semibold text-ink">{row.symbol}</span>
      {row.daily && (
        <span
          className="-ml-1 self-start text-[0.65rem] font-bold text-warn"
          title="Daily close"
          aria-label="daily close"
        >
          D
        </span>
      )}
    </>
  );
  const title = [row.displayName, row.isIndex ? INDEX_BADGE : null, 'Open its price chart']
    .filter(Boolean)
    .join(' · ');
  const cls = 'flex items-center gap-2 text-left hover:underline disabled:opacity-60';
  return (
    <div className="min-w-0">
      {row.instrumentId ? (
        <Link
          href={`/research?instrument=${encodeURIComponent(row.instrumentId)}`}
          className={cls}
          title={title}
        >
          {label}
        </Link>
      ) : (
        <button
          type="button"
          className={cls}
          title={title}
          disabled={pending}
          onClick={() => void find(row.symbol)}
        >
          {label}
        </button>
      )}
      {error && <p className="mt-1 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** The last price; the digits that just moved light up green or red for a moment. */
function LastPrice({ row }: { row: WatchRowDto }) {
  const text = formatWatchLast(row.last, row.isIndex);
  const before = useRef<{ text: string; value: number | null }>({ text, value: row.last });
  const [flash, setFlash] = useState<{ at: number; up: boolean } | null>(null);
  useEffect(() => {
    const prev = before.current;
    before.current = { text, value: row.last };
    if (prev.text === text || prev.value === null || row.last === null) return;
    setFlash({ at: changedFrom(prev.text, text), up: row.last > prev.value });
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [text, row.last]);
  if (!flash) return <span className="text-content">{text}</span>;
  return (
    <span className="text-content">
      {text.slice(0, flash.at)}
      <span className={flash.up ? 'text-ok' : 'text-danger'}>{text.slice(flash.at)}</span>
    </span>
  );
}

/** A small "…" menu of a row's actions. */
function RowMenu({
  label,
  children,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const close = () => ref.current?.removeAttribute('open');
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);
  return (
    <details ref={ref} className="relative inline-block text-left">
      <summary
        aria-label={label}
        className="flex size-7 cursor-pointer list-none items-center justify-center rounded text-ink-muted hover:bg-surface-2 hover:text-ink [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden>⋯</span>
      </summary>
      <div
        role="menu"
        className="absolute right-0 z-10 mt-1 min-w-36 rounded-md border border-line bg-surface py-1 shadow-lg"
      >
        {children(close)}
      </div>
    </details>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        'block w-full px-3 py-1.5 text-left text-sm whitespace-nowrap hover:bg-surface-2',
        danger && 'text-danger',
      )}
    >
      {children}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cx('size-3.5 transition-transform', !open && '-rotate-90')}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function NameInput({
  label,
  initial,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  onSave: (name: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(value);
      }}
    >
      <input
        aria-label={label}
        autoFocus
        maxLength={40}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        className="h-8 w-48 rounded-md border border-line bg-surface px-2 text-sm"
      />
      <Button size="sm" type="submit" variant="primary">
        Save
      </Button>
      <Button size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

/** The "+" form of one section: a ticker or company name, found through the person's feed. */
function AddSymbol({
  groupId,
  groupName,
  canSearchMarket,
  onAdd,
  onDone,
}: {
  groupId: string;
  groupName: string;
  canSearchMarket: boolean;
  onAdd: (input: {
    groupId: string;
    symbol: string;
    instrumentId?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  onDone: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const { lookup, error, find, reset, pending } = useInstrumentLookup((found) => {
    void onAdd({
      groupId,
      symbol: found.symbol,
      instrumentId: found.id,
      displayName: found.displayName,
    }).then((ok) => {
      if (ok) setQuery('');
    });
  });
  const q = query.trim();
  const searched = lookup && !pending ? lookup : null;

  return (
    <div className="border-b border-line bg-surface-2/40 px-4 py-3">
      <form
        className="flex flex-wrap items-center gap-2"
        aria-label={`Add to ${groupName}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (!q) return;
          if (canSearchMarket) void find(q);
          else
            void onAdd({ groupId, symbol: q }).then((ok) => {
              if (ok) setQuery('');
            });
        }}
      >
        <label htmlFor={`${id}-q`} className="sr-only">
          Symbol to add to {groupName}
        </label>
        <input
          id={`${id}-q`}
          type="search"
          autoFocus
          autoComplete="off"
          maxLength={60}
          placeholder="Ticker or company name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            reset();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onDone();
          }}
          className="h-8 w-60 rounded-md border border-line bg-surface px-3 text-sm"
        />
        <Button type="submit" size="sm" variant="primary" disabled={!q || pending}>
          {pending ? 'Finding…' : 'Add'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </form>
      <p role="status" aria-live="polite" className="sr-only">
        {pending ? `Searching for ${q}` : ''}
      </p>
      {searched?.status === 'not_found' && (
        <div className="mt-2">
          <p className="text-sm">{searched.message}</p>
          <CandidateList
            candidates={searched.candidates}
            disabled={pending}
            onPick={(symbol) => void find(symbol)}
          />
        </div>
      )}
      {(error || searched?.status === 'failed') && (
        <div className="mt-2">
          <Alert>{error ?? searched?.message}</Alert>
        </div>
      )}
    </div>
  );
}
