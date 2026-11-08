'use client';

import {
  ApiError,
  type InstrumentOptionDto,
  type OptionChainDto,
  type OptionHistoryDto,
} from '@tm/contracts';
import {
  CBOE_OPTIONS_DISPLAY_TERMS,
  expectedMoveCone,
  type ConePoint,
  type LiveChainView,
} from '@tm/domain';
import { Alert, Badge, Card, Table, Td, Th, cx } from '@tm/ui';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import {
  FIGURE_ROW,
  figureDetail,
  formatChainTime,
  formatCount,
  formatExpiry,
  formatGreek,
  formatOptionFigure,
  formatPct,
  optionFigureHelp,
  optionFigureLabel,
} from '@/lib/options-text';
import { MiniLine, StrikeBars } from './options-charts';

const POLL_MS = 1000;
const GIVE_UP_MS = 90_000;

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const compactUsd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Research › Options (options data brief v2 §7, §10 item 8; ADR 0048): how far
 * the market expects the stock to move and how options are positioned, from
 * the delayed chain priced by the app itself. Never a source quote or greek
 * (§8): the chain table shows the app's computed IV, delta and gamma, with
 * open interest and volume.
 */
export function OptionsPanel({
  instrument,
  optionsFeed,
  onCone,
}: {
  instrument: InstrumentOptionDto;
  /** The tenant's options feed, by name; null when there is none. */
  optionsFeed: string | null;
  /** Hands the expected-move cone to the price chart (null clears it). */
  onCone: (cone: ConePoint[] | null) => void;
}) {
  const [chain, setChain] = useState<OptionChainDto | null>(null);
  const [history, setHistory] = useState<OptionHistoryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const demo = instrument.venue === 'DEMO';
  const applies = !demo && optionsFeed !== null;

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    clearTimeout(timer.current);
    setChain(null);
    setHistory(null);
    setError(null);
    onCone(null);
    if (!applies) return;
    const mine = ++request.current;
    const stale = () => mine !== request.current;
    const deadline = Date.now() + GIVE_UP_MS;
    setLoading(true);
    const settle = (c: OptionChainDto) => {
      if (stale()) return;
      if (c.view) setChain(c);
      if (c.status === 'pending') {
        if (Date.now() > deadline) {
          setLoading(false);
          setError('The option chain is taking longer than expected. Try again in a minute.');
          return;
        }
        timer.current = setTimeout(() => {
          apiClient.research.getOptionChain(c.symbol).then(settle, () => {
            if (stale()) return;
            setLoading(false);
            setError('Could not check on the option chain. Try again.');
          });
        }, POLL_MS);
        return;
      }
      setLoading(false);
      setChain(c);
      if (c.status === 'failed') setError(c.message ?? 'The option chain could not be loaded.');
    };
    apiClient.research.optionChain({ symbol: instrument.symbol }).then(settle, (err: unknown) => {
      if (stale()) return;
      setLoading(false);
      setError(err instanceof ApiError ? err.message : 'Could not load the option chain.');
    });
    apiClient.research.optionHistory(instrument.symbol).then(
      (h) => !stale() && setHistory(h),
      () => undefined,
    );
  }, [applies, instrument.symbol, reload, onCone]);

  const view = chain?.view ?? null;
  useEffect(() => {
    onCone(view ? expectedMoveCone(view) : null);
  }, [view, onCone]);

  return (
    <Card>
      <section aria-labelledby="options-heading" className="space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="options-heading" className="text-lg font-semibold">
            Options
          </h2>
          {view && (
            <button
              type="button"
              className="rounded-md border border-line px-2 py-0.5 text-xs hover:bg-surface-2 disabled:opacity-50"
              disabled={loading || chain?.status === 'pending'}
              onClick={() => setReload((n) => n + 1)}
              title="A chain is kept for 15 minutes; after that this fetches a new one"
            >
              Refresh
            </button>
          )}
        </header>
        {demo ? (
          <p className="text-sm text-ink-muted">
            Demo instruments have no options. Pick a real US stock or ETF to see its options data.
          </p>
        ) : optionsFeed === null ? (
          <div className="text-sm">
            <p>
              See how far the market expects this stock to move, and how its options are positioned,
              by turning on the options feed.
            </p>
            <p className="mt-1 text-ink-muted">
              CBOE delayed options (daily) is free and needs no key:{' '}
              <Link href="/settings/data-feeds" className="underline">
                add it under Settings › Data feeds
              </Link>
              .
            </p>
          </div>
        ) : (
          <>
            <p role="status" aria-live="polite" className="text-sm text-ink-muted">
              {loading ? `Loading ${instrument.symbol} option chain…` : ''}
            </p>
            {error && <Alert>{error}</Alert>}
            {view && <ChainView view={view} history={history} />}
            {!view && !loading && history?.latest && (
              <p className="text-sm text-ink-muted">Latest recorded day: {history.latest.date}.</p>
            )}
            {view && (
              <footer className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <Badge>{`Options from ${optionsFeed}`}</Badge>
                <span>
                  Chain at {formatChainTime(view.chainTime)} (about 15 minutes delayed), priced at{' '}
                  {view.underlyingPrice.toFixed(2)}
                  {view.priceSource === 'close' ? ' (last close)' : ''}. IV, delta and gamma are the
                  app’s own (Black–Scholes–Merton, risk-free {formatPct(view.riskFreeRate, 2)},
                  dividend yield {formatPct(view.dividendYield, 2)}).
                </span>
                <span className="basis-full">{CBOE_OPTIONS_DISPLAY_TERMS.attribution}.</span>
              </footer>
            )}
          </>
        )}
      </section>
    </Card>
  );
}

function ChainView({ view, history }: { view: LiveChainView; history: OptionHistoryDto | null }) {
  const [expiry, setExpiry] = useState(() => defaultExpiry(view));
  useEffect(() => setExpiry(defaultExpiry(view)), [view]);
  const chosen = view.expiries.find((e) => e.expiry === expiry) ?? view.expiries[0];
  const [scope, setScope] = useState<'expiry' | 'all'>('expiry');

  const smile = useMemo(
    () =>
      (chosen?.strikes ?? []).map((s) => {
        // The out-of-the-money side's IV; the in-the-money side carries the same value.
        const iv =
          s.strike >= view.underlyingPrice ? (s.call?.iv ?? s.put?.iv) : (s.put?.iv ?? s.call?.iv);
        return { x: s.strike, y: iv ?? null, label: String(s.strike) };
      }),
    [chosen, view.underlyingPrice],
  );
  const term = view.expiries
    .filter((e) => e.daysToExpiry >= 1)
    .map((e) => ({ x: e.daysToExpiry, y: e.atmIv, label: `${e.daysToExpiry}d (${e.expiry})` }));
  const oi =
    scope === 'all'
      ? view.oiByStrike.map((o) => ({ strike: o.strike, call: o.callOi, put: o.putOi }))
      : (chosen?.strikes ?? []).map((s) => ({
          strike: s.strike,
          call: s.call?.openInterest ?? 0,
          put: s.put?.openInterest ?? 0,
        }));
  const gex =
    scope === 'all'
      ? view.gexByStrike.map((g) => ({ strike: g.strike, call: g.callGex, put: g.putGex }))
      : (chosen?.strikes ?? []).map((s) => ({
          strike: s.strike,
          call: s.callGex ?? 0,
          put: s.putGex ?? 0,
        }));
  const ivHistory = (history?.points ?? []).map((p, i) => ({
    x: i,
    y: p.iv30,
    light: p.source === 'rebuilt',
    label: p.date,
  }));

  return (
    <div className="space-y-6">
      <dl
        className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5"
        data-testid="options-figures"
      >
        {FIGURE_ROW.map((f) => {
          const detail = figureDetail(f, view.values);
          return (
            <div key={f} title={optionFigureHelp(f)}>
              <dt className="text-xs text-ink-muted">{optionFigureLabel(f)}</dt>
              <dd className="text-data-strong">
                {formatOptionFigure(f, view.values[f])}
                {detail && (
                  <span className="ml-1 text-xs font-normal text-ink-muted">({detail})</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {view.values.iv_rank_252d == null && (
        <p className="text-xs text-ink-muted">
          IV rank and percentile need 120 recorded days of IV30
          {view.ivHistoryDays > 0 ? `; ${view.ivHistoryDays} so far` : ''}.
        </p>
      )}
      <details className="text-xs text-ink-muted">
        <summary className="cursor-pointer">What these figures mean</summary>
        <dl className="mt-2 space-y-1">
          {FIGURE_ROW.map((f) => (
            <div key={f}>
              <dt className="inline font-medium text-ink">{optionFigureLabel(f)}: </dt>
              <dd className="inline">{optionFigureHelp(f)}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="block text-xs font-medium text-ink-muted">Expiry</span>
          <select
            className="mt-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
            value={chosen?.expiry ?? ''}
            onChange={(e) => setExpiry(e.target.value)}
          >
            {view.expiries.map((e) => (
              <option key={e.expiry} value={e.expiry}>
                {formatExpiry(e.expiry, e.daysToExpiry)}
              </option>
            ))}
          </select>
        </label>
        {chosen && (
          <p className="pb-1 text-sm text-ink-muted tabular-nums">
            ATM IV {formatPct(chosen.atmIv)} · 25-delta put {formatPct(chosen.putIv25d)} · call{' '}
            {formatPct(chosen.callIv25d)}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <MiniLine
          title={`IV smile, ${chosen?.expiry ?? ''}`}
          points={smile}
          formatY={(v) => formatPct(v)}
          xLabel="Strike"
          yLabel="Implied volatility"
          marker={{ x: view.underlyingPrice, label: 'Price' }}
        />
        <MiniLine
          title="Term structure (ATM IV by expiry)"
          points={term}
          formatY={(v) => formatPct(v)}
          xLabel="Days to expiry"
          yLabel="ATM implied volatility"
        />
      </div>

      <div className="space-y-2">
        <div role="group" aria-label="Strikes from" className="flex items-center gap-2 text-xs">
          <span className="font-medium text-ink-muted">Open interest and gamma for</span>
          {(
            [
              ['expiry', 'this expiry'],
              ['all', 'all expiries'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={scope === v}
              onClick={() => setScope(v)}
              className={cx(
                'rounded border border-line px-2 py-0.5',
                scope === v ? 'bg-surface-2 font-semibold' : 'text-ink-muted',
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <StrikeBars
            title="Open interest by strike"
            bars={oi}
            price={view.underlyingPrice}
            format={(v) => compact.format(v)}
          />
          <StrikeBars
            title="Gamma exposure by strike ($ per 1% move)"
            bars={gex}
            price={view.underlyingPrice}
            format={(v) => compactUsd.format(v)}
            net
          />
        </div>
        <p className="text-xs text-ink-muted">
          Gamma exposure assumes dealers are short every put and long every call, which nobody can
          check: a positioning gauge, not a measured dealer book.
        </p>
      </div>

      {history?.recorded ? (
        <MiniLine
          title="IV30, recorded each day"
          points={ivHistory}
          formatY={(v) => formatPct(v)}
          xLabel="Day"
          yLabel="IV30"
          legend={
            ivHistory.some((p) => p.light) ? (
              <p className="text-xs text-ink-muted">
                Lighter dashed line: history rebuilt from option closing prices (approximate).
              </p>
            ) : undefined
          }
        />
      ) : (
        history && (
          <p className="text-sm text-ink-muted">
            {view.symbol} isn’t in the daily recording yet, so there is no IV history or IV rank. It
            joins when a strategy uses it.
          </p>
        )
      )}

      {chosen && (
        <details>
          <summary className="cursor-pointer text-sm">
            Chain for {chosen.expiry}: the app’s computed IV, delta and gamma
          </summary>
          <div className="mt-2 max-h-[28rem] overflow-auto">
            <Table label={`${view.symbol} options expiring ${chosen.expiry}`}>
              <thead>
                <tr>
                  <Th numeric>Call IV</Th>
                  <Th numeric>Delta</Th>
                  <Th numeric>Gamma</Th>
                  <Th numeric>OI</Th>
                  <Th numeric>Volume</Th>
                  <Th numeric>Strike</Th>
                  <Th numeric>Put IV</Th>
                  <Th numeric>Delta</Th>
                  <Th numeric>Gamma</Th>
                  <Th numeric>OI</Th>
                  <Th numeric>Volume</Th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {chosen.strikes.map((s) => (
                  <tr
                    key={s.strike}
                    className={
                      s.strike === chosen.atmStrike ? 'bg-surface-2 font-medium' : undefined
                    }
                  >
                    <Td numeric>{formatPct(s.call?.iv)}</Td>
                    <Td numeric>{formatGreek(s.call?.delta, 2)}</Td>
                    <Td numeric>{formatGreek(s.call?.gamma, 4)}</Td>
                    <Td numeric>{formatCount(s.call?.openInterest)}</Td>
                    <Td numeric>{formatCount(s.call?.volume)}</Td>
                    <Td numeric className="font-semibold">
                      {s.strike}
                      {s.strike === chosen.atmStrike && (
                        <span className="sr-only"> (at the money)</span>
                      )}
                    </Td>
                    <Td numeric>{formatPct(s.put?.iv)}</Td>
                    <Td numeric>{formatGreek(s.put?.delta, 2)}</Td>
                    <Td numeric>{formatGreek(s.put?.gamma, 4)}</Td>
                    <Td numeric>{formatCount(s.put?.openInterest)}</Td>
                    <Td numeric>{formatCount(s.put?.volume)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            Strikes within 30% of the price. A dash means the contract had no usable quote (no bid,
            or a spread wider than 40% of the mid). The shaded row is at the money.
          </p>
        </details>
      )}
    </div>
  );
}

/** The first expiry at least 7 days out, as a sensible opening view. */
function defaultExpiry(view: LiveChainView): string {
  return (view.expiries.find((e) => e.daysToExpiry >= 7) ?? view.expiries[0])?.expiry ?? '';
}
