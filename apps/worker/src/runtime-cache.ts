import {
  BarLoadError,
  seriesKey,
  type InstrumentRef,
  type LoadedData,
  type SeriesPlan,
} from '@tm/backtest';
import {
  addDays,
  nyDate,
  regularSession,
  type Bar,
  type BarInterval,
  type BarRequest,
  type BarSeries,
  type BuiltinUniverse,
  type HistoricalDataProvider,
} from '@tm/domain';

/**
 * What the paper runtime keeps between passes (ADR 0087, design v1.2 N13).
 *
 * A runtime gets a pass about every second. Before this, each pass asked the
 * feed for every series the rules read, from scratch: fine for a few
 * instruments, but a stock group of 500 would have sent about 500 requests a
 * second against a key allowed 200 a minute. Now a series is loaded once and
 * then only asked again when a new bar of its size can have finished; the
 * requests of one pass go out together, so a feed that takes many symbols per
 * request (Alpaca) answers a whole group in a few.
 */

const MINUTE = 60_000;
/** Minutes per bar, for bar sizes that end inside the session. */
const STEP_MINUTES: Partial<Record<BarInterval, number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
};
/** Wait after a bar ends before asking for it: feeds publish a bar a little after it ends. */
export function graceMs(interval: BarInterval): number {
  return STEP_MINUTES[interval] ? 20_000 : 5 * MINUTE;
}
/** A bar expected but not in yet is asked again this often, for a few minutes. */
export const MISSING_RETRY_MS = 30_000;
const MISSING_RETRY_WINDOW_MS = 3 * MINUTE;
/** A series that failed to load is asked again after this long, not every pass. */
export const FAILED_RETRY_MS = 60_000;
/** Series no runtime has read for this long are dropped. */
export const IDLE_MS = 15 * MINUTE;

/**
 * When the next bar of `interval` ends after `t`: the next clock multiple of
 * the bar size inside a regular session (the last bar ends at the close), or
 * the next session's close for daily and weekly bars.
 */
export function nextBarEnd(interval: BarInterval, t: number): number {
  const step = (STEP_MINUTES[interval] ?? 0) * MINUTE;
  let date = nyDate(new Date(t));
  for (let i = 0; i < 15; i++, date = addDays(date, 1)) {
    const s = regularSession(date);
    if (!s) continue;
    const open = Date.parse(s.open);
    const close = Date.parse(s.close);
    if (close <= t) continue;
    if (!step) return close;
    const from = Math.max(t, open);
    return Math.min(Math.floor(from / step) * step + step, close);
  }
  return t + 86_400_000;
}

/** When the latest bar of `interval` that has ended by `t` ended, or undefined. */
export function lastBarEnd(interval: BarInterval, t: number): number | undefined {
  const step = (STEP_MINUTES[interval] ?? 0) * MINUTE;
  let date = nyDate(new Date(t));
  for (let i = 0; i < 15; i++, date = addDays(date, -1)) {
    const s = regularSession(date);
    if (!s) continue;
    const open = Date.parse(s.open);
    const close = Date.parse(s.close);
    if (open >= t) continue;
    if (close <= t) return close;
    if (!step) continue;
    const end = Math.floor(t / step) * step;
    if (end > open) return end;
  }
  return undefined;
}

/** When a series fetched at `t`, whose newest bar ends at `latest`, is next asked again. */
export function nextCheckAt(interval: BarInterval, t: number, latest: number | undefined): number {
  const expected = lastBarEnd(interval, t);
  // A bar that should be in but isn't yet: ask again shortly, for a few minutes.
  // (A stock with no trades in a bar never gets one; it stops asking after that.)
  if (
    expected !== undefined &&
    (latest === undefined || latest < expected) &&
    t - expected < graceMs(interval) + MISSING_RETRY_WINDOW_MS
  )
    return t + MISSING_RETRY_MS;
  return nextBarEnd(interval, t) + graceMs(interval);
}

interface Entry {
  interval: BarInterval;
  /** Loaded bars, oldest first, from `from` on; undefined until a load works. */
  bars?: Bar[];
  from: string;
  nextCheck: number;
  /** The last load failed: why, and when to try again. */
  failed?: { error: unknown; until: number } | undefined;
  /** The earliest date each runtime reading it needs, and when it last read it. */
  wants: Map<string, { from: string; at: number }>;
}

interface Fetch {
  key: string;
  plan: SeriesPlan;
  request: BarRequest;
  incremental: boolean;
}

export interface CacheLoadInput {
  /** Whose routes answer (ADR 0084): series are shared only within one scope. */
  scope: string;
  /** The runtime reading, so a series is kept as far back as any reader needs. */
  owner: string;
  history: HistoricalDataProvider;
  plans: readonly SeriesPlan[];
  instruments: ReadonlyMap<string, InstrumentRef>;
  now: Date;
  /** Group members: when their bars fail, the pass goes on without them. */
  optional?: ReadonlySet<string>;
}

export class RuntimeBarCache {
  private readonly entries = new Map<string, Entry>();
  /** Requests sent to feeds, for tests and logs. */
  requests = 0;

  /** Bars held now, across every series. */
  get bars(): number {
    let n = 0;
    for (const e of this.entries.values()) n += e.bars?.length ?? 0;
    return n;
  }

  get series(): number {
    return this.entries.size;
  }

  /** The planned series, from memory where they are current, else from the feed. */
  async load(input: CacheLoadInput): Promise<LoadedData> {
    const t = input.now.getTime();
    this.evict(t);
    const fetches: Fetch[] = [];
    for (const plan of input.plans) {
      const instrument = input.instruments.get(plan.spec.instrumentId);
      if (!instrument) throw new Error('The strategy uses an instrument that no longer exists');
      const key = `${input.scope}|${seriesKey(plan.spec)}`;
      let entry = this.entries.get(key);
      if (!entry) {
        entry = {
          interval: plan.spec.interval,
          from: plan.from,
          nextCheck: 0,
          wants: new Map(),
        };
        this.entries.set(key, entry);
      }
      entry.wants.set(input.owner, { from: plan.from, at: t });
      const request: BarRequest = {
        ...plan.spec,
        symbol: instrument.symbol,
        assetClass: instrument.assetClass,
        from: plan.from,
        to: plan.to,
      };
      if (entry.failed && t < entry.failed.until && !entry.bars) continue;
      if (!entry.bars || plan.from < entry.from) {
        fetches.push({ key, plan, request, incremental: false });
      } else if (t >= entry.nextCheck) {
        // Only from the newest bar's day on: that day again plus anything newer.
        const newest = entry.bars.at(-1);
        const since = newest ? nyDate(newest.start) : entry.from;
        fetches.push({
          key,
          plan,
          request: { ...request, from: since < plan.to ? since : plan.to },
          incremental: true,
        });
      }
    }

    if (fetches.length > 0) {
      const results = await this.fetchAll(
        input.history,
        fetches.map((f) => f.request),
      );
      for (const [i, f] of fetches.entries()) {
        const entry = this.entries.get(f.key) as Entry;
        const r = results[i] as BarSeries | Error;
        if (r instanceof Error) {
          // Keep what is loaded; ask again in a minute rather than every pass.
          entry.failed = { error: r, until: t + FAILED_RETRY_MS };
          entry.nextCheck = t + FAILED_RETRY_MS;
          continue;
        }
        entry.failed = undefined;
        if (f.incremental && entry.bars) {
          const firstNew = r.bars[0]?.start;
          const kept =
            firstNew === undefined ? entry.bars : entry.bars.filter((b) => b.start < firstNew);
          entry.bars = [...kept, ...r.bars];
        } else {
          entry.bars = r.bars;
          entry.from = f.request.from;
        }
        const latest = entry.bars.at(-1);
        entry.nextCheck = nextCheckAt(
          entry.interval,
          t,
          latest ? Date.parse(latest.end) : undefined,
        );
      }
    }

    const series = new Map<string, Bar[]>();
    const leftOut: string[] = [];
    for (const plan of input.plans) {
      const key = `${input.scope}|${seriesKey(plan.spec)}`;
      const entry = this.entries.get(key) as Entry;
      if (entry.bars) {
        series.set(seriesKey(plan.spec), entry.bars);
        continue;
      }
      const symbol = input.instruments.get(plan.spec.instrumentId)?.symbol ?? '?';
      const error = entry.failed?.error;
      if (!input.optional?.has(plan.spec.instrumentId)) throw new BarLoadError(symbol, error);
      leftOut.push(symbol);
    }
    for (const entry of this.entries.values()) this.trim(entry, t);
    const warnings =
      leftOut.length > 0
        ? [
            `${leftOut.length} ${leftOut.length === 1 ? 'member was' : 'members were'} left out because ${leftOut.length === 1 ? 'its' : 'their'} bars could not be loaded: ${leftOut.slice(0, 5).join(', ')}${leftOut.length > 5 ? '…' : ''}`,
          ]
        : [];
    return { series, dataVersions: [], warnings };
  }

  private async fetchAll(
    history: HistoricalDataProvider,
    requests: BarRequest[],
  ): Promise<(BarSeries | Error)[]> {
    if (history.getBarsMany) {
      this.requests++;
      return history.getBarsMany(requests);
    }
    const out: (BarSeries | Error)[] = [];
    for (const r of requests) {
      this.requests++;
      out.push(
        await history
          .getBars(r)
          .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
      );
    }
    return out;
  }

  /** Bars older than any reader still needs are let go. */
  private trim(entry: Entry, t: number) {
    let from: string | undefined;
    for (const w of entry.wants.values())
      if (t - w.at < IDLE_MS && (from === undefined || w.from < from)) from = w.from;
    if (!from || from <= entry.from || !entry.bars) return;
    const keep = from;
    entry.bars = entry.bars.filter((b) => nyDate(b.start) >= keep);
    entry.from = keep;
  }

  private evict(t: number) {
    for (const [key, entry] of this.entries) {
      for (const [owner, w] of entry.wants) if (t - w.at >= IDLE_MS) entry.wants.delete(owner);
      if (entry.wants.size === 0) this.entries.delete(key);
    }
  }
}

/**
 * Built-in stock groups' members for paper runs, as back tests resolve them,
 * looked up once a day per person and group (a failed lookup is tried again
 * after five minutes, keeping yesterday's list meanwhile).
 */
export class RuntimeUniverses {
  private readonly cache = new Map<
    string,
    { date: string; ids: string[]; refs: Map<string, InstrumentRef>; retryAt?: number }
  >();

  constructor(
    private readonly resolve?: (
      userId: string,
      group: BuiltinUniverse,
    ) => Promise<{ ids: string[]; warnings: string[] }>,
  ) {}

  async members(
    userId: string,
    group: BuiltinUniverse,
    now: Date,
    refsOf: (ids: string[]) => Promise<Map<string, InstrumentRef>>,
  ): Promise<{ ids: string[]; refs: Map<string, InstrumentRef> }> {
    const key = `${userId}|${group}`;
    const date = nyDate(now);
    const t = now.getTime();
    const cached = this.cache.get(key);
    if (cached && (cached.date === date || (cached.retryAt !== undefined && t < cached.retryAt)))
      return cached;
    if (!this.resolve) throw new Error('This worker cannot resolve built-in stock groups');
    try {
      const { ids } = await this.resolve(userId, group);
      const refs = await refsOf(ids);
      const entry = { date, ids: ids.filter((id) => refs.has(id)), refs };
      this.cache.set(key, entry);
      return entry;
    } catch (error) {
      if (!cached) throw error;
      cached.retryAt = t + 5 * MINUTE;
      return cached;
    }
  }
}

/**
 * Data besides bars a pass reads (events, filings, options signals, model
 * scores): it changes at most a few times a day, so a runtime reloads it when
 * a new bar is in, when the members change, or after a minute.
 */
export class RuntimeSideData<T> {
  private readonly cache = new Map<string, { key: string; at: number; data: T }>();
  static readonly TTL_MS = 60_000;

  async get(runtimeId: string, key: string, t: number, fresh: boolean, load: () => Promise<T>) {
    const hit = this.cache.get(runtimeId);
    if (hit && !fresh && hit.key === key && t - hit.at < RuntimeSideData.TTL_MS) return hit.data;
    const data = await load();
    this.cache.set(runtimeId, { key, at: t, data });
    for (const [id, e] of this.cache) if (t - e.at > IDLE_MS) this.cache.delete(id);
    return data;
  }
}
