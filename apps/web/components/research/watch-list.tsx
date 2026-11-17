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
  symbolHue,
  WATCH_POLL_MS,
  type WatchGroupDto,
  type WatchListDto,
  type WatchRowDto,
} from '@/lib/watch-list';

/**
 * The watch list (N292, ADR 0101): groups of symbols, each row's last price
 * and change since the previous close, refreshed every few seconds while the
 * page is open. Gains green, losses red, signs kept with their figures (N289).
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
  const act = useCallback(
    async (change: Promise<WatchActionResult>) => {
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
    <div className="max-w-3xl space-y-4">
      <AddSymbol
        groups={list.groups}
        canSearchMarket={canSearchMarket}
        onAdd={(input) => act(addWatchSymbol(input))}
        onNewGroup={(name) => act(createWatchGroup(name))}
      />
      {!canSearchMarket && (
        <Alert>
          Prices need a US stock price feed. Add an Alpaca data feed with your paper API key in{' '}
          <Link href="/settings/data-feeds">Settings › Data feeds</Link>.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      <Card className="overflow-x-auto p-0">
        {list.groups.length === 0 ? (
          <p className="p-4 text-sm text-ink-muted">
            Your watch list is empty. Add a group, then add symbols to it.
          </p>
        ) : (
          <table aria-label="Watch list" className="w-full min-w-[30rem] text-sm">
            <thead>
              <tr className="border-b border-line text-ink-muted">
                <th scope="col" className="py-2 pr-2 pl-4 text-left font-semibold">
                  Symbol
                </th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">
                  Last
                </th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">
                  Chg
                </th>
                <th scope="col" className="px-2 py-2 text-right font-semibold">
                  Chg%
                </th>
                <th scope="col" className="w-10 py-2 pr-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            {list.groups.map((g, gi) => (
              <GroupRows
                key={g.id}
                group={g}
                first={gi === 0}
                last={gi === list.groups.length - 1}
                onFold={() => fold(g)}
                act={act}
              />
            ))}
          </table>
        )}
      </Card>
      <p className="text-xs text-ink-muted" role="status" aria-live="off">
        {offline
          ? 'Prices are not updating: the app cannot be reached. Retrying…'
          : `Updated ${new Date(list.asOf).toLocaleTimeString('en-US')}. Prices refresh every few seconds while US stocks trade (4 AM to 8 PM New York), once a minute otherwise.`}{' '}
        Alpaca’s free feed has IEX exchange trades only. Indices are followed through the ETFs that
        track them (SPY, QQQ, DIA, IWM), so their Chg% moves with the index. D marks a daily close,
        such as the VIX from Cboe’s end-of-day history.
      </p>
    </div>
  );
}

function GroupRows({
  group,
  first,
  last,
  onFold,
  act,
}: {
  group: WatchGroupDto;
  first: boolean;
  last: boolean;
  onFold: () => void;
  act: (change: Promise<WatchActionResult>) => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const bodyId = useId();
  return (
    <tbody aria-label={group.name}>
      <tr>
        <td colSpan={4} className="pt-4 pr-2 pb-1 pl-2">
          {renaming ? (
            <NameInput
              label="Group name"
              initial={group.name}
              onCancel={() => setRenaming(false)}
              onSave={async (name) => {
                if (await act(renameWatchListGroup(group.id, name))) setRenaming(false);
              }}
            />
          ) : (
            <button
              type="button"
              aria-expanded={!group.collapsed}
              aria-controls={bodyId}
              onClick={onFold}
              className="flex items-center gap-2 rounded px-2 py-1 text-xs font-semibold tracking-wide text-ink-muted uppercase hover:text-ink"
            >
              <Chevron open={!group.collapsed} />
              {group.name}
              <span className="sr-only">, {group.rows.length} symbols</span>
            </button>
          )}
        </td>
        <td className="pt-4 pr-2 pb-1 text-right">
          <RowMenu label={`${group.name} group actions`}>
            {(close) => (
              <>
                <MenuItem
                  onClick={() => {
                    close();
                    setRenaming(true);
                  }}
                >
                  Rename
                </MenuItem>
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
                  Delete group
                </MenuItem>
              </>
            )}
          </RowMenu>
        </td>
      </tr>
      {!group.collapsed && group.rows.length === 0 && (
        <tr id={bodyId}>
          <td colSpan={5} className="px-4 pb-2 text-ink-muted">
            No symbols yet.
          </td>
        </tr>
      )}
      {!group.collapsed &&
        group.rows.map((r, i) => (
          <WatchRow
            key={r.id}
            row={r}
            rowId={i === 0 ? bodyId : undefined}
            first={i === 0}
            last={i === group.rows.length - 1}
            act={act}
          />
        ))}
    </tbody>
  );
}

function WatchRow({
  row,
  rowId,
  first,
  last,
  act,
}: {
  row: WatchRowDto;
  rowId: string | undefined;
  first: boolean;
  last: boolean;
  act: (change: Promise<WatchActionResult>) => Promise<boolean>;
}) {
  const priced = row.priceAt
    ? `${row.daily ? 'Daily close of' : 'Last trade'} ${new Date(row.priceAt).toLocaleString('en-US')}`
    : 'No price yet';
  return (
    <tr id={rowId} className="border-b border-line/60 last:border-b-0 hover:bg-surface-2">
      <td className="py-2 pr-2 pl-4">
        <SymbolCell row={row} />
      </td>
      <td className="px-2 py-2 text-right whitespace-nowrap" title={priced}>
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
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-[0.65rem] font-bold text-white"
        style={{ backgroundColor: `hsl(${symbolHue(row.symbol)} 55% 42%)` }}
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

/** Adds a symbol to a group, found through the person's data feed; or starts a group. */
function AddSymbol({
  groups,
  canSearchMarket,
  onAdd,
  onNewGroup,
}: {
  groups: readonly WatchGroupDto[];
  canSearchMarket: boolean;
  onAdd: (input: {
    groupId: string;
    symbol: string;
    instrumentId?: string | null;
    displayName?: string | null;
  }) => Promise<boolean>;
  onNewGroup: (name: string) => Promise<boolean>;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [groupId, setGroupId] = useState(groups.at(-1)?.id ?? '');
  const [naming, setNaming] = useState(false);
  const target = groups.some((g) => g.id === groupId) ? groupId : (groups.at(-1)?.id ?? '');
  // A group just started is where the next symbol goes.
  const count = useRef(groups.length);
  useEffect(() => {
    if (groups.length > count.current) setGroupId(groups.at(-1)?.id ?? '');
    count.current = groups.length;
  }, [groups]);
  const { lookup, error, find, reset, pending } = useInstrumentLookup((found) => {
    void onAdd({
      groupId: target,
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
    <Card>
      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label="Add to watch list"
          onSubmit={(e) => {
            e.preventDefault();
            if (!q || !target) return;
            if (canSearchMarket) void find(q);
            else
              void onAdd({ groupId: target, symbol: q }).then((ok) => {
                if (ok) setQuery('');
              });
          }}
        >
          <div>
            <label htmlFor={`${id}-q`} className="block text-sm font-semibold text-ink-muted">
              Add a symbol
            </label>
            <input
              id={`${id}-q`}
              type="search"
              autoComplete="off"
              maxLength={60}
              placeholder="Ticker or company name"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                reset();
              }}
              className="mt-1 h-9 w-56 rounded-md border border-line bg-surface px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor={`${id}-g`} className="block text-sm font-semibold text-ink-muted">
              To group
            </label>
            <select
              id={`${id}-g`}
              value={target}
              onChange={(e) => setGroupId(e.target.value)}
              disabled={groups.length === 0}
              className="mt-1 h-9 rounded-md border border-line bg-surface px-2 text-sm"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" size="sm" variant="primary" disabled={!q || !target || pending}>
            {pending ? 'Finding…' : 'Add'}
          </Button>
        </form>
        <div className="ml-auto">
          {naming ? (
            <NameInput
              label="New group name"
              initial=""
              onCancel={() => setNaming(false)}
              onSave={async (name) => {
                if (await onNewGroup(name)) setNaming(false);
              }}
            />
          ) : (
            <Button size="sm" onClick={() => setNaming(true)}>
              New group
            </Button>
          )}
        </div>
      </div>
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
    </Card>
  );
}
