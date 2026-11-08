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
  columnHeader,
  formatCell,
  isSigned,
  hasCompanyFigures,
  hasOptionFigures,
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
import { bare } from '@/lib/units';

const POLL_MS = 1000;
/** The first screen of the whole market downloads a month of prices; give it time. */
const GIVE_UP_MS = 10 * 60_000;
const PAGE_SIZES = [50, 100, 250, 1000] as const;

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
  demoData = false,
  initialQuery,
}: {
  canScreenMarket: boolean;
  /** Whether the demo feed can stand in for a real one; tests only (ADR 0039). */
  demoData?: boolean;
  initialQuery: string;
}) {
  const router = useRouter();
  // With a real feed the screen opens on the S&P 500; a demo feed (tests) has only its own instruments.
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
  const [pageSize, setPageSize] = useState<number>(100);
  /** Which stocks the rows on screen cover: the S&P 500 only, or the whole market. */
  const loaded = useRef<Universe | null>(null);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async (want: Universe, fresh: boolean) => {
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
      const started = await apiClient.research.screen({ universe: want, fresh });
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
          loaded.current = want;
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

  // The S&P 500 loads on its own, in seconds; the whole market only when asked for.
  // Rows of the whole market already cover the S&P 500, so going back needs no load.
  const want: Universe = canScreenMarket ? universe : 'all';
  // With no feed at all there is nothing to screen; the notice above says what to add.
  const screenable = canScreenMarket || demoData;
  useEffect(() => {
    if (!screenable || loaded.current === 'all' || loaded.current === want) return;
    void load(want, false);
  }, [want, load, screenable]);
  useEffect(() => () => clearTimeout(timer.current), []);

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
  const inUniverse = counts[want];
  const exchanges = useMemo(() => [...new Set((rows ?? []).map((r) => r.exchange))].sort(), [rows]);
  const pages = Math.max(1, Math.ceil(matched.length / pageSize));
  const shownPage = Math.min(page, pages - 1);
  const visible = matched.slice(shownPage * pageSize, (shownPage + 1) * pageSize);
  // Company columns stay out of the way until a company data feed fills them (ADR 0031).
  const companyFigures = hasCompanyFigures(rows);
  // Options columns likewise, until the options feed and the daily recording fill them (ADR 0048).
  const optionFigures = hasOptionFigures(rows);
  const shownColumns = NUMBER_COLUMNS.filter(
    (c) =>
      columns.includes(c.key) && (!c.company || companyFigures) && (!c.options || optionFigures),
  );
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
          {demoData
            ? 'The screener shows the demo instruments. To screen every US stock and ETF, add an Alpaca data feed in '
            : 'To screen US stocks and ETFs, add an Alpaca data feed with your paper API key in '}
          <Link href="/settings/data-feeds" className="underline">
            Settings › Data feeds
          </Link>
          .
        </Alert>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p role="status" aria-live="polite" className="text-sm text-ink-muted">
            {loading
              ? want === 'sp500'
                ? 'Getting prices for the S&P 500…'
                : canScreenMarket
                  ? 'Getting prices for every US stock and ETF… the first screen of the day takes a minute or two.'
                  : 'Getting prices…'
              : rows && screen
                ? `${matched.length.toLocaleString('en-US')} of ${inUniverse.toLocaleString('en-US')} ${universe === 'sp500' ? 'S&P 500 stocks' : inUniverse === 1 ? 'stock' : 'stocks and ETFs'} match`
                : ''}
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" onClick={() => void load(want, true)} disabled={loading}>
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

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[1fr_1.5fr_1fr_1fr_1.3fr_1.5fr_auto]">
          <label className="text-sm font-semibold text-ink-muted">
            Stock group
            <select
              value={want}
              disabled={!canScreenMarket}
              title={canScreenMarket ? undefined : 'Add an Alpaca data feed to screen real stocks'}
              onChange={(e) => {
                setUniverse(e.target.value as Universe);
                setPage(0);
              }}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm disabled:opacity-60"
            >
              {canScreenMarket ? (
                <>
                  <option value="sp500">S&amp;P 500</option>
                  <option value="all">All US stocks</option>
                </>
              ) : (
                <option value="all">{demoData ? 'Demo instruments' : 'All US stocks'}</option>
              )}
            </select>
          </label>
          <label className="text-sm font-semibold text-ink-muted">
            Symbol or name
            <input
              type="search"
              value={filters.text}
              onChange={(e) => changeFilters({ text: e.target.value })}
              placeholder="e.g. NVDA or bank"
              className="mt-1 block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm font-semibold text-ink-muted">
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
          <label className="text-sm font-semibold text-ink-muted">
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
          <label className="text-sm font-semibold text-ink-muted">
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
          <label className="text-sm font-semibold text-ink-muted">
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
                  label={columnHeader(c)}
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
                        'border-b border-line px-3 py-1.5 text-right whitespace-nowrap text-content',
                        signed && (v > 0 ? 'text-ok' : 'text-danger'),
                        v === null && 'text-ink-muted',
                      )}
                    >
                      {bare(formatCell(v, c.format))}
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

      {rows && matched.length > PAGE_SIZES[0] && (
        <nav
          aria-label="Result pages"
          className="flex flex-wrap items-center justify-end gap-2 text-sm"
        >
          <label className="mr-auto flex items-center gap-2 text-ink-muted">
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString('en-US')}
                </option>
              ))}
            </select>
          </label>
          <span className="text-ink-muted">
            {(shownPage * pageSize + 1).toLocaleString('en-US')}–
            {Math.min((shownPage + 1) * pageSize, matched.length).toLocaleString('en-US')} of{' '}
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
          {!companyFigures && (
            <span className="basis-full">
              For market cap, P/E, revenue and earnings columns, add a company data feed under{' '}
              <Link className="underline" href="/settings/data-feeds">
                Settings › Data feeds
              </Link>
              .
            </span>
          )}
          {!optionFigures && (
            <span className="basis-full">
              For IV30, IV rank, expected move and other options columns, add the CBOE delayed
              options feed under{' '}
              <Link className="underline" href="/settings/data-feeds">
                Settings › Data feeds
              </Link>
              . They cover the stocks and ETFs in the daily options recording.
            </span>
          )}
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
