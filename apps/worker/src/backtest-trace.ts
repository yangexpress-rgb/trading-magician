import type { SeriesPlan } from '@tm/backtest';
import type { BarRequest, BarSeries, HistoricalDataProvider } from '@tm/domain';
import type { Logger } from 'pino';

/**
 * Stage timings for one back test attempt (diagnosis of abandoned runs,
 * 2026-11-11). Every line carries identifiers, counts, timings and memory
 * only: never a symbol list, a key, an address or account data.
 *
 * Log events:
 * - `backtest.stage`: one per finished stage, with its elapsed ms and counts.
 * - `backtest.lease`: each lease renewal, with the gap since the last one.
 * - `backtest.heartbeat`: every `heartbeatMs` while the attempt runs, with the
 *   current stage and memory, so the last line before a crash says where it was.
 * - `backtest.summary`: the attempt's totals when it ends.
 */

const MB = 1024 * 1024;

export function memory(): { rssMb: number; heapUsedMb: number; heapTotalMb: number } {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / MB),
    heapUsedMb: Math.round(m.heapUsed / MB),
    heapTotalMb: Math.round(m.heapTotal / MB),
  };
}

/** Bars a day holds at each interval in the regular session (for estimates only). */
const BARS_PER_DAY: Record<string, number> = {
  '1m': 390,
  '5m': 78,
  '15m': 26,
  '30m': 13,
  '1h': 7,
  '4h': 2,
  '1d': 1,
  '1w': 0.2,
};

/** About 252 trading days in 365 calendar days. */
const tradingDays = (from: string, to: string) =>
  Math.max(0, Math.round(((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1) * (252 / 365)));

/** Series counts, date ranges and estimated bars per interval of a run's plan. */
export function describePlan(plans: readonly SeriesPlan[]) {
  const byInterval: Record<
    string,
    { series: number; from: string; to: string; estimatedBars: number }
  > = {};
  for (const p of plans) {
    const k = p.spec.interval;
    const e = (byInterval[k] ??= { series: 0, from: p.from, to: p.to, estimatedBars: 0 });
    e.series++;
    if (p.from < e.from) e.from = p.from;
    if (p.to > e.to) e.to = p.to;
    e.estimatedBars += Math.round(tradingDays(p.from, p.to) * (BARS_PER_DAY[k] ?? 1));
  }
  const estimatedBars = Object.values(byInterval).reduce((n, e) => n + e.estimatedBars, 0);
  return { series: plans.length, estimatedBars, byInterval };
}

interface IntervalLoad {
  calls: number;
  bars: number;
  ms: number;
  longestCallMs: number;
  errors: Record<string, number>;
}

export class BacktestTrace {
  private readonly started = Date.now();
  private stageName = 'claim';
  private stageStarted = Date.now();
  private lastRenewal = Date.now();
  private longestRenewalGapMs = 0;
  private longestRenewalGapStage = 'claim';
  private renewals = 0;
  private readonly timer: ReturnType<typeof setInterval> | undefined;
  private peakRssMb = 0;
  private peakHeapMb = 0;
  readonly loads = new Map<string, IntervalLoad>();

  constructor(
    private readonly logger: Pick<Logger, 'info' | 'warn'>,
    private readonly base: {
      runId: string;
      workerId: string;
      leaseSeconds: number;
      maxAttempts: number;
    },
    heartbeatMs = 15_000,
  ) {
    if (heartbeatMs > 0) {
      this.timer = setInterval(() => this.heartbeat(), heartbeatMs);
      this.timer.unref?.();
    }
  }

  private sample() {
    const m = memory();
    this.peakRssMb = Math.max(this.peakRssMb, m.rssMb);
    this.peakHeapMb = Math.max(this.peakHeapMb, m.heapUsedMb);
    return m;
  }

  /** Marks the attempt number once the run's row is read. */
  attempt = 0;

  /** Starts a stage; the returned function ends it with its counts. */
  stage(name: string): (counts?: Record<string, unknown>) => number {
    this.stageName = name;
    this.stageStarted = Date.now();
    const started = this.stageStarted;
    return (counts = {}) => {
      const ms = Date.now() - started;
      this.logger.info(
        {
          event: 'backtest.stage',
          ...this.base,
          attempt: this.attempt,
          stage: name,
          ms,
          sinceLeaseRenewalMs: Date.now() - this.lastRenewal,
          ...this.sample(),
          ...counts,
        },
        `back test stage ${name}`,
      );
      return ms;
    };
  }

  /** Records a lease renewal (or a lost lease) and the gap since the last one. */
  renewed(ok: boolean) {
    const now = Date.now();
    const gap = now - this.lastRenewal;
    if (gap > this.longestRenewalGapMs) {
      this.longestRenewalGapMs = gap;
      this.longestRenewalGapStage = this.stageName;
    }
    this.lastRenewal = now;
    this.renewals++;
    // Every renewal during a load would flood the log: write the first, the
    // lost ones, and any that came after more than half the lease.
    if (!ok || this.renewals === 1 || gap > (this.base.leaseSeconds * 1000) / 2) {
      this.logger[ok ? 'info' : 'warn'](
        {
          event: 'backtest.lease',
          ...this.base,
          attempt: this.attempt,
          stage: this.stageName,
          ok,
          gapMs: gap,
          renewals: this.renewals,
        },
        ok ? 'back test lease renewed' : 'back test lease lost',
      );
    }
  }

  private heartbeat() {
    this.logger.info(
      {
        event: 'backtest.heartbeat',
        ...this.base,
        attempt: this.attempt,
        stage: this.stageName,
        stageMs: Date.now() - this.stageStarted,
        sinceLeaseRenewalMs: Date.now() - this.lastRenewal,
        elapsedMs: Date.now() - this.started,
        ...this.sample(),
        loads: this.loadsByInterval(),
      },
      'back test heartbeat',
    );
  }

  /** Wraps a bar provider to count calls, bars, time and errors per interval. */
  provider(inner: HistoricalDataProvider): HistoricalDataProvider {
    return {
      ...inner,
      getBars: async (req: BarRequest): Promise<BarSeries> => {
        const load = this.loads.get(req.interval) ?? {
          calls: 0,
          bars: 0,
          ms: 0,
          longestCallMs: 0,
          errors: {},
        };
        this.loads.set(req.interval, load);
        const t = Date.now();
        try {
          const result = await inner.getBars(req);
          load.bars += result.bars.length;
          return result;
        } catch (e) {
          const name = e instanceof Error ? e.name : 'unknown';
          load.errors[name] = (load.errors[name] ?? 0) + 1;
          throw e;
        } finally {
          const ms = Date.now() - t;
          load.calls++;
          load.ms += ms;
          load.longestCallMs = Math.max(load.longestCallMs, ms);
        }
      },
    };
  }

  loadsByInterval() {
    return Object.fromEntries(this.loads);
  }

  /** Ends the attempt: totals, longest lease gap and peaks. */
  finish(outcome: string) {
    if (this.timer) clearInterval(this.timer);
    const tail = Date.now() - this.lastRenewal;
    if (tail > this.longestRenewalGapMs) {
      this.longestRenewalGapMs = tail;
      this.longestRenewalGapStage = this.stageName;
    }
    this.logger.info(
      {
        event: 'backtest.summary',
        ...this.base,
        attempt: this.attempt,
        outcome,
        elapsedMs: Date.now() - this.started,
        renewals: this.renewals,
        longestRenewalGapMs: this.longestRenewalGapMs,
        longestRenewalGapStage: this.longestRenewalGapStage,
        peakRssMb: this.peakRssMb,
        peakHeapUsedMb: this.peakHeapMb,
        loads: this.loadsByInterval(),
      },
      'back test attempt finished',
    );
  }
}
