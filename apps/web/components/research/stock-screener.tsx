'use client';

import { ApiError, type StockScreenDto } from '@tm/contracts';
import {
  fromScreenTuple,
  SP500_AS_OF,
  SP500_SECTORS,
  type ScreenNumberColumn,
  type ScreenRow,
} from '@tm/domain';
import { Alert, Badge, Button, cx } from '@tm/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
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
import { type FilterDef, FilterBar, PillMenu } from '../filters/filter-bar';
import { useInstrumentLookup } from '../strategy/use-instrument-lookup';
import { bare } from '@/lib/units';

const POLL_MS = 1000;
/** The first screen of the whole market downloads a month of prices; give it time. */
const GIVE_UP_MS = 10 * 60_000;
const PAGE_SIZES = [50, 100, 250, 1000] as const;
/** Range filters shown as pills before they are set; the rest are in the Filter menu. */
const PINNED_RANGES: readonly ScreenNumberColumn[] = ['last', 'changePct', 'marketCap'];

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

  const clearRange = (key: ScreenNumberColumn) => {
    const next = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== key)) as RawRanges;
    const ranges = Object.fromEntries(
      Object.entries(filters.ranges).filter(([k]) => k !== key),
    ) as ScreenFilters['ranges'];
    setRaw(next);
    changeFilters({ ranges });
  };

  // Type and sector, and the main price columns, are pinned as pills; every
  // other column waits in the Filter menu (N195).
  const filterDefs: FilterDef[] = [
    {
      kind: 'choice',
      key: 'type',
      label: 'Type',
      pinned: true,
      anyValue: 'all',
      value: filters.type,
      options: [
        { value: 'stock', label: 'Stocks' },
        { value: 'etf', label: 'ETFs' },
      ],
    },
    {
      kind: 'choice',
      key: 'sector',
      label: 'Sector',
      pinned: true,
      value: filters.sector,
      hint: 'GICS sector, for S&P 500 members',
      options: SECTORS.map((x) => ({ value: x, label: x })),
    },
    {
      kind: 'choice',
      key: 'exchange',
      label: 'Exchange',
      value: filters.exchange,
      options: exchanges.map((x) => ({ value: x, label: x })),
    },
    ...NUMBER_COLUMNS.filter(
      (c) =>
        ((!c.company || companyFigures) && (!c.options || optionFigures)) ||
        filters.ranges[c.key] !== undefined,
    ).map((c): FilterDef => ({
      kind: 'range',
      key: c.key,
      label: c.label,
      pinned: PINNED_RANGES.includes(c.key),
      min: raw[c.key]?.min ?? '',
      max: raw[c.key]?.max ?? '',
      invalid: (text) => parseAmount(text) === undefined,
      hint: `${c.hint}. Amounts can be written like 2, -1.5, 250k or 1.5M${c.format === 'pct' ? '; in percent' : ''}.`,
    })),
  ];

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

      {/* Compact filter pills that apply at once (N195); the rest wait in the Filter menu. */}
      <section aria-label="Screen filters" className="space-y-2">
        <FilterBar
          label="Screen filters"
          leading={[
            {
              kind: 'choice',
              key: 'universe',
              label: 'Stock group',
              setting: true,
              value: want,
              disabled: !canScreenMarket,
              title: canScreenMarket ? undefined : 'Add an Alpaca data feed to screen real stocks',
              options: canScreenMarket
                ? [
                    { value: 'sp500', label: 'S&P 500' },
                    { value: 'all', label: 'All US stocks' },
                  ]
                : [{ value: 'all', label: demoData ? 'Demo instruments' : 'All US stocks' }],
            },
          ]}
          search={{
            label: 'Symbol or name',
            value: filters.text,
            placeholder: 'Symbol or name, e.g. NVDA or bank',
            onChange: (text) => changeFilters({ text }),
          }}
          filters={filterDefs}
          onChoice={(key, value) => {
            if (key === 'universe') {
              setUniverse(value as Universe);
              setPage(0);
            } else if (key === 'type') changeFilters({ type: value as ScreenFilters['type'] });
            else if (key === 'exchange') changeFilters({ exchange: value });
            else if (key === 'sector') changeFilters({ sector: value });
          }}
          onRange={(key, end, text) => setRange(key as ScreenNumberColumn, end, text)}
          onRemove={(key) => {
            if (key === 'type') changeFilters({ type: 'all' });
            else if (key === 'exchange' || key === 'sector') changeFilters({ [key]: '' });
            else clearRange(key as ScreenNumberColumn);
          }}
          onClear={clearFilters}
          actions={
            <>
              <PillMenu
                label="Ready-made screens"
                menuLabel="Ready-made screens"
                align="right"
                items={presets.map((p) => ({ value: p.id, label: p.label }))}
                onPick={applyPreset}
              />
              <ColumnPicker columns={columns} onChange={setColumns} />
              <Button size="sm" onClick={() => void load(want, true)} disabled={loading}>
                Refresh prices
              </Button>
              <Button size="sm" onClick={exportCsv} disabled={!rows || matched.length === 0}>
                Download CSV
              </Button>
            </>
          }
        />
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
          {!loading && screen?.status === 'ready' && (
            <span className="text-xs">
              {' · '}
              {screen.sessionDate &&
                `“Today” is the session of ${nyDay(screen.sessionDate)}; “yesterday” is the one before. `}
              Prices as of {nyTime(screen.updatedAt)} New York time.
            </span>
          )}
        </p>
        {error && <Alert>{error}</Alert>}
      </section>

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

function ColumnPicker({
  columns,
  onChange,
}: {
  columns: ScreenNumberColumn[];
  onChange: (columns: ScreenNumberColumn[]) => void;
}) {
  return (
    <details className="relative">
      <summary className="flex h-8 cursor-pointer list-none items-center rounded-full border border-line bg-surface px-3 text-sm hover:bg-surface-2">
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
