/**
 * One Alpaca key's request budget within this process (ADR 0052). Alpaca's
 * free plan allows 200 requests a minute per key, and the options recording
 * can share a key with a person's strategies (ADR 0050). Requests a person is
 * waiting on, or that run a strategy, always go at once. Background work (the
 * options recording and its history rebuild) waits its turn: it takes at most
 * a share of the minute, never the room kept for everything else, and stands
 * aside after Alpaca has throttled the key.
 *
 * Options quotes (options trading brief v0.2 §8.2, ADR 0123) are a third
 * class between the two: below a strategy's equity requests, above background
 * work. They go only while the minute leaves room kept for equity, at most
 * `optionsPerMinute` of them, and stand aside after a throttle like background
 * work, so options traffic can never take an equity request's slot. Equity
 * requests are never made to wait by anything.
 */

/** An options request found no room in the minute; it was not sent (ADR 0123). */
export class OptionsBudgetFullError extends Error {
  constructor() {
    super('No room for options requests on this key this minute');
    this.name = 'OptionsBudgetFullError';
  }
}

/** Who a request is for (ADR 0052, ADR 0123). `true`/`false` are background/foreground. */
export type RequestClass = boolean | 'options';

export interface RequestBudgetOptions {
  /** Requests Alpaca allows each key a minute. */
  perMinute?: number;
  /** The most background requests in any minute. */
  backgroundPerMinute?: number;
  /** Room in each minute that background requests never take. */
  reserve?: number;
  /**
   * Background requests that may go each minute even into the reserve, while
   * the key is under Alpaca's limit, so busy strategies can't starve them.
   */
  backgroundFloor?: number;
  /** Options class (ADR 0123): the most options requests in any minute. */
  optionsPerMinute?: number;
  /** Options class: room in each minute that options requests never take, kept for equity. */
  optionsReserve?: number;
  /** How long background requests stand aside after a 429 that gave no time. */
  pauseAfterThrottleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface KeyState {
  /** When each request of the last minute went, and whether it was background. */
  sent: { at: number; background: boolean; options?: true }[];
  pausedUntil: number;
}

const MINUTE = 60_000;

/** What happened to one request, for the per-minute traffic log. */
export interface RequestOutcome {
  host: 'data' | 'trading';
  /** The path with symbols and ids folded away, e.g. /v2/stocks/:symbol/snapshot. */
  route: string;
  background: boolean;
  /** HTTP status, or 'timeout' / 'network' when no answer came. */
  status: number | 'timeout' | 'network';
  ms: number;
}

/** One key's traffic since the last drain. */
export interface KeyTraffic {
  /** The key id's last four characters; the full id is never logged. */
  key: string;
  requests: number;
  data: number;
  trading: number;
  background: number;
  throttled: number;
  timeouts: number;
  failed: number;
  slowestMs: number;
  /** Requests per route, busiest first (top 8). */
  routes: { route: string; n: number; throttled: number }[];
}

interface TrafficState {
  requests: number;
  data: number;
  trading: number;
  background: number;
  throttled: number;
  timeouts: number;
  failed: number;
  slowestMs: number;
  routes: Map<string, { n: number; throttled: number }>;
}

const emptyTraffic = (): TrafficState => ({
  requests: 0,
  data: 0,
  trading: 0,
  background: 0,
  throttled: 0,
  timeouts: 0,
  failed: 0,
  slowestMs: 0,
  routes: new Map(),
});

export class AlpacaRequestBudget {
  private readonly perMinute: number;
  private readonly backgroundPerMinute: number;
  private readonly reserve: number;
  private readonly backgroundFloor: number;
  private readonly optionsPerMinute: number;
  private readonly optionsReserve: number;
  private readonly pauseMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly keys = new Map<string, KeyState>();
  private traffic = new Map<string, TrafficState>();

  constructor(options: RequestBudgetOptions = {}) {
    this.perMinute = options.perMinute ?? 200;
    this.backgroundPerMinute = options.backgroundPerMinute ?? 60;
    this.reserve = options.reserve ?? 80;
    this.backgroundFloor = Math.min(options.backgroundFloor ?? 10, this.backgroundPerMinute);
    this.optionsPerMinute = options.optionsPerMinute ?? 40;
    this.optionsReserve = options.optionsReserve ?? 40;
    this.pauseMs = options.pauseAfterThrottleMs ?? MINUTE;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  private state(key: string): KeyState {
    let s = this.keys.get(key);
    if (!s) {
      s = { sent: [], pausedUntil: 0 };
      this.keys.set(key, s);
    }
    const since = this.now() - MINUTE;
    while ((s.sent[0]?.at ?? Infinity) <= since) s.sent.shift();
    return s;
  }

  /**
   * Counts a request against the key. A background request first waits until
   * it fits; anything else goes at once.
   */
  async take(key: string, background: RequestClass): Promise<void> {
    for (;;) {
      const s = this.state(key);
      const now = this.now();
      if (!background) {
        s.sent.push({ at: now, background });
        return;
      }
      if (background === 'options') {
        if (this.takeOptions(key)) return;
        throw new OptionsBudgetFullError();
      }
      const wait = this.backgroundWait(s, now);
      if (wait <= 0) {
        s.sent.push({ at: now, background });
        return;
      }
      await this.sleep(Math.min(wait, MINUTE));
    }
  }

  private backgroundWait(s: KeyState, now: number): number {
    if (now < s.pausedUntil) return s.pausedUntil - now;
    // Wait for the oldest request that keeps us over a limit to leave the minute.
    const until = (list: { at: number }[], over: number) => {
      const oldest = list.length >= over ? list[list.length - over] : undefined;
      return oldest ? oldest.at + MINUTE - now + 1 : 0;
    };
    const bg = s.sent.filter((r) => r.background);
    // A few background requests a minute always go while the key is under
    // Alpaca's limit: foreground traffic that keeps the minute past the reserve
    // (running strategies) would otherwise hold a back test's bars forever.
    if (bg.length < this.backgroundFloor && s.sent.length < this.perMinute - 1) return 0;
    return Math.max(
      until(s.sent, Math.max(1, this.perMinute - this.reserve)),
      until(bg, Math.max(1, this.backgroundPerMinute)),
    );
  }

  /**
   * Options class (ADR 0123): counts one options request if it fits now, else
   * returns false at once. Options requests never wait: a runtime pass that
   * waited for room would hold every other strategy's pass back.
   */
  takeOptions(key: string): boolean {
    const s = this.state(key);
    const now = this.now();
    if (this.optionsWait(s, now) > 0) return false;
    s.sent.push({ at: now, background: false, options: true });
    return true;
  }

  /** Options class: how long until one more options request fits (0 = now). */
  private optionsWait(s: KeyState, now: number): number {
    if (now < s.pausedUntil) return s.pausedUntil - now;
    const until = (list: { at: number }[], over: number) => {
      const oldest = list.length >= over ? list[list.length - over] : undefined;
      return oldest ? oldest.at + MINUTE - now + 1 : 0;
    };
    const opts = s.sent.filter((r) => r.options);
    return Math.max(
      until(s.sent, Math.max(1, this.perMinute - this.optionsReserve)),
      until(opts, Math.max(1, this.optionsPerMinute)),
    );
  }

  /** Alpaca throttled the key: background requests stand aside until it says, or a minute. */
  throttled(key: string, retryAfterMs: number | undefined): void {
    const s = this.state(key);
    s.pausedUntil = Math.max(s.pausedUntil, this.now() + (retryAfterMs ?? this.pauseMs));
  }

  /** Counts one request's outcome for the traffic log. Changes nothing else. */
  record(key: string, outcome: RequestOutcome): void {
    let t = this.traffic.get(key);
    if (!t) {
      t = emptyTraffic();
      this.traffic.set(key, t);
    }
    t.requests++;
    t[outcome.host]++;
    if (outcome.background) t.background++;
    const throttled = outcome.status === 429;
    if (throttled) t.throttled++;
    else if (outcome.status === 'timeout') t.timeouts++;
    else if (typeof outcome.status !== 'number' || outcome.status >= 400) t.failed++;
    t.slowestMs = Math.max(t.slowestMs, outcome.ms);
    const r = t.routes.get(outcome.route) ?? { n: 0, throttled: 0 };
    r.n++;
    if (throttled) r.throttled++;
    t.routes.set(outcome.route, r);
  }

  /** Every key's traffic since the last call, and starts counting afresh. */
  drainTraffic(): KeyTraffic[] {
    const out: KeyTraffic[] = [];
    for (const [key, t] of this.traffic) {
      out.push({
        key: key.slice(-4),
        requests: t.requests,
        data: t.data,
        trading: t.trading,
        background: t.background,
        throttled: t.throttled,
        timeouts: t.timeouts,
        failed: t.failed,
        slowestMs: Math.round(t.slowestMs),
        routes: [...t.routes]
          .map(([route, r]) => ({ route, ...r }))
          .sort((a, b) => b.n - a.n)
          .slice(0, 8),
      });
    }
    this.traffic = new Map();
    return out;
  }

  /** Tests: how many options requests the key sent in the last minute. */
  optionsLastMinute(key: string): number {
    return this.state(key).sent.filter((r) => r.options).length;
  }

  /** Tests: how many requests the key sent in the last minute. */
  sentLastMinute(key: string): number {
    return this.state(key).sent.length;
  }
}

/** The budget every Alpaca client in this process shares, per key. */
export const sharedAlpacaBudget = new AlpacaRequestBudget();
