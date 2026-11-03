'use client';

import { ApiError, type StockScreenDto } from '@tm/contracts';
import {
  fromScreenTuple,
  SP500_AS_OF,
  SP500_SECTORS,
  type ScreenNumberColumn,
  type ScreenRow,
} from '@tm/domain';
import { Alert, Badge, Button, Card, cx } from '@tm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  activeFilterCount,
  COLUMN_BY_KEY,
  decodeScreenState,
  EMPTY_FILTERS,
  encodeScreenState,
  filterRows,
  formatCell,
  isSigned,
  NUMBER_COLUMNS,
  parseAmount,
  screenPresets,
  sectorOf,
  SECTORS,
  sortRows,
  toCsv,
  type ScreenFilters,
  type SortKey,
  type SortState,
  type Universe,
} from '@/lib/screener';
import { useInstrumentLookup } from '../strategy/use-instrument-lookup';

const POLL_MS = 1000;
/** The first screen of the whole market downloads a month of prices; give it time. */
const GIVE_UP_MS = 5 * 60_000;
const PAGE_SIZE = 50;

type RawRanges = Partial<Record<ScreenNumberColumn, { min: string; max: string }>>;

const rawFrom = (ranges: ScreenFilters['ranges']): RawRanges =>
  Object.fromEntries(
    Object.entries(ranges).map(([k, r]) => [
      k,
      {
        min: r?.min === undefined ? '' : String(r.min),
        max: r?.max === undefined ? '' : String(r.max),
      },
    ]),
  );

const nyTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  });
const nyDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

/**
 * The stock screener (ADR 0030): every stock and ETF the person's data feed
 * covers, one row of key values each. Each value column can be sorted and
 * narrowed to a range; the screen's filters live in the address.
 */
export function StockScreener({
  canScreenMarket,
  initialQuery,
}: {
  canScreenMarket: boolean;
  initialQuery: string;
}) {
  const router = useRouter();
  // With a real feed the screen opens on the S&P 500; the demo feed has only its own instruments.
  const defaultUniverse: Universe = canScreenMarket ? 'sp500' : 'all';
  const start = useMemo(
    () => decodeScreenState(new URLSearchParams(initialQuery), defaultUniverse),
    [initialQuery, defaultUniverse],
  );
  const [universe, setUniverse] = useState<Universe>(start.universe);
  const [screen, setScreen] = useState<StockScreenDto | null>(null);
  const [rows, setRows] = useState<ScreenRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ScreenFilters>(start.filters);
  const [raw, setRaw] = useState<RawRanges>(() => rawFrom(start.filters.ranges));
  const [sort, setSort] = useState<SortState>(start.sort);
  const [columns, setColumns] = useState<ScreenNumberColumn[]>(
    start.columns ?? NUMBER_COLUMNS.filter((c) => c.shown).map((c) => c.key),
  );
  const [page, setPage] = useState(0);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async (fresh: boolean) => {
    clearTimeout(timer.current);
    const mine = ++request.current;
    setLoading(true);
    setError(null);
    const fail = (message: string) => {
      if (mine !== request.current) return;
      setError(message);
      setLoading(false);
    };
    try {
      const started = await apiClient.research.screen({ fresh });
      const deadline = Date.now() + GIVE_UP_MS;
      const settle = async (current: StockScreenDto) => {
        if (mine !== request.current) return;
        setScreen(current);
        if (current.status === 'failed') {
          fail(current.message ?? 'The screen could not be made.');
          return;
        }
        if (current.status === 'ready') {
          const data = await apiClient.research.getScreenRows(current.id);
          if (mine !== request.current) return;
          setRows((data.rows ?? []).map(fromScreenTuple));
          setScreen(data);
          setLoading(false);
          return;
        }
        if (Date.now() > deadline) {
          fail('The screen is taking longer than expected. Try again in a minute.');
          return;
        }
        timer.current = setTimeout(() => {
          apiClient.research
            .getScreen(current.id)
            .then(settle, () => fail('Could not check on the screen. Try again.'));
        }, POLL_MS);
      };
      await settle(started);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : 'Could not start the screen.');
    }
  }, []);

  useEffect(() => {
    void load(false);
    return () => clearTimeout(timer.current);
  }, [load]);

  // Keep the screen in the address without a navigation.
  useEffect(() => {
    const defaults = NUMBER_COLUMNS.filter((c) => c.shown).map((c) => c.key);
    const same = columns.length === defaults.length && columns.every((c, i) => c === defaults[i]);
    const q = encodeScreenState(
      filters,
      sort,
      same ? null : columns,
      universe,
      defaultUniverse,
    ).toString();
    window.history.replaceState(null, '', q ? `?${q}` : window.location.pathname);
  }, [filters, sort, columns, universe, defaultUniverse]);

  const matched = useMemo(
    () => (rows ? sortRows(filterRows(rows, filters, universe), sort) : []),
    [rows, filters, sort, universe],
  );
  const counts = useMemo(
    () => ({
      all: rows?.length ?? 0,
      sp500: rows?.filter((r) => SP500_SECTORS.has(r.symbol)).length ?? 0,
    }),
    [rows],
  );
  const inUniverse = counts[universe];
  const exchanges = useMemo(() => [...new Set((rows ?? []).map((r) => r.exchange))].sort(), [rows]);
  const pages = Math.max(1, Math.ceil(matched.length / PAGE_SIZE));
  const shownPage = Math.min(page, pages - 1);
  const visible = matched.slice(shownPage * PAGE_SIZE, (shownPage + 1) * PAGE_SIZE);
  const shownColumns = NUMBER_COLUMNS.filter((c) => columns.includes(c.key));
  const iex = (screen?.warnings ?? []).some((w) => /IEX/.test(w));
  const presets = useMemo(() => screenPresets(iex), [iex]);
  const active = activeFilterCount(filters);

  const changeFilters = (patch: Partial<ScreenFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  const setRange = (key: ScreenNumberColumn, end: 'min' | 'max', text: string) => {
    const next: RawRanges = {
      ...raw,
      [key]: { min: raw[key]?.min ?? '', max: raw[key]?.max ?? '', [end]: text },
    };
    const ranges: ScreenFilters['ranges'] = {};
    for (const [k, v] of Object.entries(next)) {
      const min = parseAmount(v?.min ?? '');
      const max = parseAmount(v?.max ?? '');
      if (min !== undefined || max !== undefined) ranges[k as ScreenNumberColumn] = { min, max };
    }
    setRaw(next);
    changeFilters({ ranges });
  };

  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    const next = { ...EMPTY_FILTERS, ...preset.filters };
    setFilters(next);
    setRaw(rawFrom(next.ranges));
    setSort(preset.sort);
    setPage(0);
  };

  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setRaw({});
    setPage(0);
  };

  const toggleSort = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'symbol' || key === 'name' || key === 'sector' ? 'asc' : 'desc' },
    );
    setPage(0);
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv(matched, shownColumns)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-screen-${screen?.sessionDate ?? 'today'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Charting a stock that is not registered yet looks it up first, as the picker does.
  const [opening, setOpening] = useState<string | null>(null);
  const {
    lookup,
    error: lookupError,
    find,
  } = useInstrumentLookup((instrument) => {
    router.push(`/research?instrument=${encodeURIComponent(instrument.id)}`);
  });
  const lookupFailed =
    lookupError ??
    (lookup && lookup.status !== 'pending' && lookup.status !== 'found'
      ? (lookup.message ?? `Could not open ${opening ?? 'that stock'}.`)
      : null);

  return (
    <div className="space-y-4">
      {!canScreenMarket && (
        <Alert tone="info">
          The screener shows the demo instruments. To screen every US stock and ETF, add an Alpaca
          data feed in{' '}
          <Link href="/settings/data-feeds" className="underline">
            Settings › Data feeds
          </Link>
          .
        </Alert>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div role="group" aria-label="Stocks to screen" className="flex items-center gap-2">
            <span className="text-xs font-medium text-ink-muted">Screen</span>
            <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5">
              {(
                [
                  ['sp500', 'S&P 500'],
                  ['all', canScreenMarket ? 'All US stocks and ETFs' : 'All demo instruments'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={universe === value}
                  disabled={value === 'sp500' && !canScreenMarket}
                  title={
                    value === 'sp500' && !canScreenMarket
                      ? 'Add an Alpaca data feed to screen real stocks'
                      : undefined
                  }
                  onClick={() => {
                    setUniverse(value);
                    setPage(0);
                  }}
                  className={cx(
                    'h-7 rounded px-2.5 text-sm disabled:cursor-not-allowed disabled:opacity-40',
                    universe === value
                      ? 'bg-surface font-semibold text-ink shadow-sm'
                      : 'text-ink-muted',
                  )}
                >
                  {label}
                  {rows && (value === 'all' || canScreenMarket)
                    ? ` (${counts[value].toLocaleString('en-US')})`
                    : ''}
                </button>
              ))}
            </div>
          </div>
          <p role="status" aria-live="polite" className="text-sm text-ink-muted">
            {loading
              ? canScreenMarket
                ? 'Getting prices for every US stock and ETF… the first screen of the day takes up to a minute.'
                : 'Getting prices…'
              : rows && screen
                ? `${matched.length.toLocaleString('en-US')} of ${inUniverse.toLocaleString('en-US')} ${universe === 'sp500' ? 'S&P 500 stocks' : inUniverse === 1 ? 'stock' : 'stocks and ETFs'} match`
                : ''}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" onClick={() => void load(true)} disabled={loading}>
              Refresh prices
            </Button>
            <Button size="sm" onClick={exportCsv} disabled={!rows || matched.length === 0}>
              Download CSV
            </Button>
          </div>
        </div>
        {screen?.status === 'ready' && (
          <p className="mt-1 text-xs text-ink-muted">
            {screen.sessionDate &&
              `“Today” is the session of ${nyDay(screen.sessionDate)}; “yesterday” is the one before. `}
            Prices as of {nyTime(screen.updatedAt)} New York time.
          </p>
        )}

        {error && (
          <div className="mt-3">
            <Alert>{error}</Alert>
          </div>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[1.6fr_1fr_1fr_1.3fr_1.5fr_auto]">
          <label className="text-sm font-medium">
            Symbol or name
            <input
              type="search"
              value={filters.text}
              onChange={(e) => changeFilters({ text: e.target.value })}
              placeholder="e.g. NVDA or bank"
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-medium">
            Type
            <select
              value={filters.type}
              onChange={(e) => changeFilters({ type: e.target.value as ScreenFilters['type'] })}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            >
              <option value="all">Stocks and ETFs</option>
              <option value="stock">Stocks</option>
              <option value="etf">ETFs</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Exchange
            <select
              value={filters.exchange}
              onChange={(e) => changeFilters({ exchange: e.target.value })}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            >
              <option value="">All exchanges</option>
              {exchanges.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            Sector
            <select
              value={filters.sector}
              onChange={(e) => changeFilters({ sector: e.target.value })}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            >
              <option value="">All sectors</option>
              {SECTORS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm font-medium">
            Start from a ready-made screen
            <select
              value=""
              onChange={(e) => applyPreset(e.target.value)}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            >
              <option value="">Choose…</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2">
            <ColumnPicker columns={columns} onChange={setColumns} />
            <Button size="sm" variant="ghost" onClick={clearFilters} disabled={active === 0}>
              Clear filters{active > 0 ? ` (${active})` : ''}
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Narrow any column with its min and max boxes; amounts can be written like 2, -1.5, 250k or
          1.5M. Percent columns are in percent. Click a heading to sort.
        </p>
      </Card>

      {lookupFailed && <Alert>{lookupFailed}</Alert>}

      <div
        tabIndex={0}
        role="group"
        aria-label="Screen results"
        className="overflow-x-auto rounded-lg border border-line bg-surface"
      >
        <table aria-label="Screen results" className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <HeaderCell label="Symbol" sortKey="symbol" sort={sort} onSort={toggleSort} sticky />
              <HeaderCell label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <HeaderCell
                label="Sector"
                title="GICS sector, for S&P 500 members"
                sortKey="sector"
                sort={sort}
                onSort={toggleSort}
              />
              {shownColumns.map((c) => (
                <HeaderCell
                  key={c.key}
                  label={c.label}
                  title={c.hint}
                  sortKey={c.key}
                  sort={sort}
                  onSort={toggleSort}
                  numeric
                />
              ))}
            </tr>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 border-b border-line bg-surface-2 px-2 py-1"
              >
                <span className="sr-only">Filters</span>
              </th>
              <th scope="col" className="border-b border-line bg-surface-2 px-2 py-1" />
              <th scope="col" className="border-b border-line bg-surface-2 px-2 py-1" />
              {shownColumns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className="border-b border-line bg-surface-2 px-2 py-1 font-normal"
                >
                  <div className="flex gap-1">
                    <RangeInput
                      label={`${c.label}, at least`}
                      placeholder="min"
                      value={raw[c.key]?.min ?? ''}
                      onChange={(v) => setRange(c.key, 'min', v)}
                    />
                    <RangeInput
                      label={`${c.label}, at most`}
                      placeholder="max"
                      value={raw[c.key]?.max ?? ''}
                      onChange={(v) => setRange(c.key, 'max', v)}
                    />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className={cx(loading && rows && 'opacity-60')}>
            {visible.map((r) => (
              <tr key={r.symbol} className="hover:bg-surface-2">
                <td className="sticky left-0 border-b border-line bg-surface px-3 py-1.5 font-semibold whitespace-nowrap">
                  {r.instrumentId ? (
                    <Link
                      href={`/research?instrument=${encodeURIComponent(r.instrumentId)}`}
                      className="text-accent hover:underline"
                      title={`Chart ${r.symbol}`}
                    >
                      {r.symbol}
                    </Link>
                  ) : (
                    <button
                      type="button"
                      className="text-accent hover:underline disabled:opacity-60"
                      title={`Chart ${r.symbol}`}
                      disabled={opening === r.symbol && lookup?.status === 'pending'}
                      onClick={() => {
                        setOpening(r.symbol);
                        void find(r.symbol);
                      }}
                    >
                      {opening === r.symbol && lookup?.status === 'pending'
                        ? `${r.symbol}…`
                        : r.symbol}
                    </button>
                  )}
                  {r.assetClass === 'etf' && (
                    <span className="ml-1 text-xs text-ink-muted">ETF</span>
                  )}
                </td>
                <td
                  className="max-w-[16rem] truncate border-b border-line px-3 py-1.5"
                  title={`${r.name} · ${r.exchange}`}
                >
                  {r.name}
                </td>
                <td className="border-b border-line px-3 py-1.5 whitespace-nowrap text-ink-muted">
                  {sectorOf(r) ?? '—'}
                </td>
                {shownColumns.map((c) => {
                  const v = r[c.key];
                  const signed = isSigned(c.key) && v !== null && v !== 0;
                  return (
                    <td
                      key={c.key}
                      className={cx(
                        'border-b border-line px-3 py-1.5 text-right whitespace-nowrap tabular-nums',
                        signed && (v > 0 ? 'text-ok' : 'text-danger'),
                        v === null && 'text-ink-muted',
                      )}
                    >
                      {formatCell(v, c.format)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows && visible.length === 0 && (
              <tr>
                <td
                  colSpan={shownColumns.length + 3}
                  className="px-3 py-10 text-center text-ink-muted"
                >
                  Nothing matches these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {rows && matched.length > PAGE_SIZE && (
        <nav aria-label="Result pages" className="flex items-center justify-end gap-2 text-sm">
          <span className="text-ink-muted">
            {(shownPage * PAGE_SIZE + 1).toLocaleString('en-US')}–
            {Math.min((shownPage + 1) * PAGE_SIZE, matched.length).toLocaleString('en-US')} of{' '}
            {matched.length.toLocaleString('en-US')}
          </span>
          <Button size="sm" onClick={() => setPage(0)} disabled={shownPage === 0}>
            First
          </Button>
          <Button size="sm" onClick={() => setPage(shownPage - 1)} disabled={shownPage === 0}>
            Previous
          </Button>
          <Button
            size="sm"
            onClick={() => setPage(shownPage + 1)}
            disabled={shownPage >= pages - 1}
          >
            Next
          </Button>
        </nav>
      )}

      {screen?.status === 'ready' && (
        <footer className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          {screen.source && <Badge>{`Prices from ${screen.source}`}</Badge>}
          <span>
            Daily prices are split-adjusted. Today’s values grow through the session; a dash means
            the stock has not traded today or lacks the history. S&P 500 members and sectors as of{' '}
            {SP500_AS_OF}.
          </span>
          {screen.warnings.map((w) => (
            <span key={w} className="basis-full">
              {w}
            </span>
          ))}
        </footer>
      )}
    </div>
  );
}

function HeaderCell({
  label,
  title,
  sortKey,
  sort,
  onSort,
  numeric,
  sticky,
}: {
  label: string;
  title?: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
  sticky?: boolean;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx(
        'border-b border-line bg-surface-2 px-3 py-2 text-xs font-semibold whitespace-nowrap text-ink-muted',
        numeric ? 'text-right' : 'text-left',
        sticky && 'sticky left-0 z-10',
      )}
    >
      <button
        type="button"
        title={title}
        onClick={() => onSort(sortKey)}
        className={cx('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}
      >
        {label}
        <span aria-hidden="true" className={cx(!active && 'opacity-30')}>
          {active && sort.dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

function RangeInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const bad = value.trim() !== '' && parseAmount(value) === undefined;
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      aria-invalid={bad}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-16 min-w-0 flex-1 rounded border border-line bg-surface px-1.5 py-1 text-right text-xs tabular-nums placeholder:text-ink-muted aria-[invalid=true]:border-danger"
    />
  );
}

function ColumnPicker({
  columns,
  onChange,
}: {
  columns: ScreenNumberColumn[];
  onChange: (columns: ScreenNumberColumn[]) => void;
}) {
  return (
    <details className="relative">
      <summary className="flex h-8 cursor-pointer list-none items-center rounded-md border border-line bg-surface px-3 text-sm font-medium hover:bg-surface-2">
        Columns ({columns.length})
      </summary>
      <fieldset className="absolute right-0 z-20 mt-1 w-72 rounded-md border border-line bg-surface p-3 shadow-lg">
        <legend className="sr-only">Columns to show</legend>
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {NUMBER_COLUMNS.map((c) => (
            <li key={c.key}>
              <label className="flex items-start gap-2 text-sm" title={c.hint}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={columns.includes(c.key)}
                  onChange={(e) =>
                    onChange(
                      NUMBER_COLUMNS.map((x) => x.key).filter((k) =>
                        k === c.key ? e.target.checked : columns.includes(k),
                      ),
                    )
                  }
                />
                <span>
                  {COLUMN_BY_KEY.get(c.key)?.label}
                  <span className="block text-xs text-ink-muted">{c.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
    </details>
  );
}
