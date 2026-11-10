'use client';

import { ApiError, type PriceChartDto } from '@tm/contracts';
import {
  addDays,
  CHART_HISTORY_CHUNK,
  chartRangeDays,
  nyDate,
  type ChartInterval,
  type ChartRange,
} from '@tm/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { mergeBars } from '@/lib/chart-history';
import { toBars, type Bar } from '@/lib/research-text';

const POLL_MS = 700;
const GIVE_UP_MS = 45_000;

/** One request for bars: a range of time ending on a date (null: today). */
interface Window {
  range: ChartRange;
  end: string | null;
}

/** Asks for a chart and waits for the worker to answer it (ADR 0029). */
async function loadChart(
  instrumentId: string,
  interval: ChartInterval,
  w: Window,
  stale: () => boolean,
): Promise<PriceChartDto | null> {
  let c: PriceChartDto;
  try {
    c = await apiClient.research.chart({
      instrumentId,
      range: w.range,
      interval,
      ...(w.end ? { end: w.end } : {}),
    });
  } catch (err) {
    throw new Error(err instanceof ApiError ? err.message : 'Could not load the prices.');
  }
  const deadline = Date.now() + GIVE_UP_MS;
  while (c.status === 'pending') {
    if (stale()) return null;
    if (Date.now() > deadline) {
      throw new Error('The prices are taking longer than expected. Try again in a minute.');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (stale()) return null;
    try {
      c = await apiClient.research.getChart(c.id);
    } catch {
      throw new Error('Could not check on the chart. Try again.');
    }
  }
  if (c.status === 'failed') throw new Error(c.message ?? 'The prices could not be loaded.');
  return c;
}

export interface SeriesState {
  bars: Bar[];
  error: string | null;
  loading: boolean;
  /** Which start of the chart the bars belong to. */
  gen: number;
}

export interface ChartHistory {
  /** The main symbol's first answer: its source, warnings, range and bars. */
  chart: PriceChartDto | null;
  /** Every loaded bar per instrument, oldest first, the main one included. */
  series: Readonly<Record<string, SeriesState>>;
  loading: boolean;
  error: string | null;
  /** Bars the first answer had, which the chart opens showing. */
  openingCount: number;
  /** Fetching an older or newer stretch after a scroll (N195). */
  extending: 'earlier' | 'later' | null;
  /** No older bars came back: the start of the feed's history. */
  atStart: boolean;
  /** The newest bars are loaded: nothing later to fetch. */
  atLatest: boolean;
  loadEarlier: () => void;
  loadLater: () => void;
}

/**
 * Bars for the Price charts page (N194–N196): the main symbol for the chosen
 * range, ending on the chosen date, plus each compared symbol over the same
 * stretch; older or newer stretches are fetched as the person scrolls.
 */
export function useChartHistory({
  instrumentId,
  range,
  interval,
  end,
  compare,
}: {
  instrumentId: string | null;
  range: ChartRange;
  interval: ChartInterval;
  end: string | null;
  compare: readonly string[];
}): ChartHistory {
  const [chart, setChart] = useState<PriceChartDto | null>(null);
  const [series, setSeries] = useState<Record<string, SeriesState>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [extending, setExtending] = useState<'earlier' | 'later' | null>(null);
  const [atStart, setAtStart] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const [openingCount, setOpeningCount] = useState(0);
  /** Bumped whenever the main chart starts over, so older answers are dropped. */
  const generation = useRef(0);
  /** The windows asked for so far, so a symbol added to compare covers the same stretch. */
  const windows = useRef<Window[]>([]);
  const mainBars = useRef<Bar[]>([]);
  const busy = useRef(false);
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const mainId = useRef(instrumentId);
  /** Compared symbols asked for since the main chart started over. */
  const requested = useRef(new Set<string>());

  /** Adds bars to one symbol; bars from before the chart started over are replaced. */
  const patch = useCallback(
    (id: string, gen: number, next: Partial<SeriesState>, add: Bar[] = []) => {
      if (gen !== generation.current) return;
      setSeries((cur) => {
        const prior = cur[id];
        const was =
          prior && prior.gen === gen ? prior : { bars: [], error: null, loading: false, gen };
        const bars = add.length ? mergeBars(was.bars, add) : was.bars;
        if (id === mainId.current) mainBars.current = bars;
        return { ...cur, [id]: { ...was, ...next, bars } };
      });
    },
    [],
  );

  /** Loads one symbol over the given windows, one after another. */
  const loadSymbol = useCallback(
    async (id: string, ws: readonly Window[], gen: number) => {
      const stale = () => gen !== generation.current;
      patch(id, gen, { loading: true, error: null });
      for (const w of ws) {
        try {
          const c = await loadChart(id, interval, w, stale);
          if (!c || stale()) return;
          patch(id, gen, {}, toBars(c.bars ?? []));
        } catch (err) {
          patch(id, gen, { loading: false, error: (err as Error).message });
          return;
        }
      }
      patch(id, gen, { loading: false });
    },
    [interval, patch],
  );

  // The main symbol, range, bar size or date changed: start over.
  useEffect(() => {
    const gen = ++generation.current;
    mainId.current = instrumentId;
    mainBars.current = [];
    busy.current = false;
    // The bars shown so far stay, dimmed, until the new ones come (N153 keeps them to their symbol).
    setExtending(null);
    setAtStart(false);
    setAtLatest(end === null);
    setError(null);
    if (!instrumentId) {
      setChart(null);
      setSeries({});
      setLoading(false);
      return;
    }
    const first: Window = { range, end };
    windows.current = [first];
    setLoading(true);
    const stale = () => gen !== generation.current;
    loadChart(instrumentId, interval, first, stale).then(
      (c) => {
        if (!c || stale()) return;
        const bars = toBars(c.bars ?? []);
        mainBars.current = bars;
        setSeries((cur) => {
          const next: Record<string, SeriesState> = {};
          for (const [id, st] of Object.entries(cur)) if (st.gen === gen) next[id] = st;
          next[instrumentId] = { bars, error: null, loading: false, gen };
          return next;
        });
        setOpeningCount(bars.length);
        setChart(c);
        setLoading(false);
      },
      (err: Error) => {
        if (stale()) return;
        setLoading(false);
        setError(err.message);
        setChart(null);
      },
    );
    requested.current = new Set();
    for (const id of compareRef.current) {
      if (id === instrumentId) continue;
      requested.current.add(id);
      void loadSymbol(id, [first], gen);
    }
  }, [instrumentId, range, interval, end, loadSymbol]);

  // A symbol added to compare is fetched over every stretch loaded so far; one taken away is dropped.
  const compareKey = compare.join(',');
  useEffect(() => {
    const gen = generation.current;
    setSeries((cur) => {
      const keep = new Set([mainId.current, ...compare]);
      const next: Record<string, SeriesState> = {};
      for (const [id, s] of Object.entries(cur)) if (keep.has(id)) next[id] = s;
      return next;
    });
    for (const id of [...requested.current]) {
      if (!compare.includes(id)) requested.current.delete(id);
    }
    if (!mainId.current) return;
    for (const id of compare) {
      if (id === mainId.current || requested.current.has(id)) continue;
      requested.current.add(id);
      void loadSymbol(id, [...windows.current], gen);
    }
    // compareKey stands for compare: a new array with the same symbols changes nothing.
  }, [compareKey, loadSymbol]);

  const extend = useCallback(
    async (direction: 'earlier' | 'later') => {
      const id = mainId.current;
      const bars = mainBars.current;
      const first = bars[0];
      const last = bars.at(-1);
      if (!id || !first || !last || busy.current) return;
      const chunk = CHART_HISTORY_CHUNK[interval];
      let w: Window;
      if (direction === 'earlier') {
        w = { range: chunk, end: addDays(nyDate(new Date(first.t)), -1) };
      } else {
        const today = nyDate(new Date());
        const to = addDays(nyDate(new Date(last.t)), chartRangeDays(chunk));
        w = { range: chunk, end: to >= today ? null : to };
      }
      busy.current = true;
      setExtending(direction);
      const gen = generation.current;
      const stale = () => gen !== generation.current;
      windows.current.push(w);
      try {
        const [c] = await Promise.all([
          loadChart(id, interval, w, stale),
          ...compareRef.current
            .filter((other) => other !== id)
            .map((other) =>
              loadChart(other, interval, w, stale).then(
                (oc) => oc && patch(other, gen, {}, toBars(oc.bars ?? [])),
                (err: Error) => patch(other, gen, { error: err.message }),
              ),
            ),
        ]);
        if (!c || stale()) return;
        const added = toBars(c.bars ?? []);
        if (direction === 'earlier') {
          if (!added.some((b) => b.t < first.t)) setAtStart(true);
        } else if (w.end === null) setAtLatest(true);
        patch(id, gen, {}, added);
      } catch (err) {
        if (stale()) return;
        // Leave the bars already shown; say why no more came.
        setError((err as Error).message);
        if (direction === 'earlier') setAtStart(true);
        else setAtLatest(true);
      } finally {
        if (!stale()) {
          busy.current = false;
          setExtending(null);
        }
      }
    },
    [interval, patch],
  );

  const loadEarlier = useCallback(() => {
    if (!atStart) void extend('earlier');
  }, [atStart, extend]);
  const loadLater = useCallback(() => {
    if (!atLatest) void extend('later');
  }, [atLatest, extend]);

  return {
    chart,
    series,
    loading,
    error,
    openingCount,
    extending,
    atStart,
    atLatest,
    loadEarlier,
    loadLater,
  };
}
