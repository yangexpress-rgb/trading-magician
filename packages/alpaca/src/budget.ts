/**
 * One Alpaca key's request budget within this process (ADR 0052). Alpaca's
 * free plan allows 200 requests a minute per key, and the options recording
 * can share a key with a person's strategies (ADR 0050). Requests a person is
 * waiting on, or that run a strategy, always go at once. Background work (the
 * options recording and its history rebuild) waits its turn: it takes at most
 * a share of the minute, never the room kept for everything else, and stands
 * aside after Alpaca has throttled the key.
 */

export interface RequestBudgetOptions {
  /** Requests Alpaca allows each key a minute. */
  perMinute?: number;
  /** The most background requests in any minute. */
  backgroundPerMinute?: number;
  /** Room in each minute that background requests never take. */
  reserve?: number;
  /** How long background requests stand aside after a 429 that gave no time. */
  pauseAfterThrottleMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface KeyState {
  /** When each request of the last minute went, and whether it was background. */
  sent: { at: number; background: boolean }[];
  pausedUntil: number;
}

const MINUTE = 60_000;

export class AlpacaRequestBudget {
  private readonly perMinute: number;
  private readonly backgroundPerMinute: number;
  private readonly reserve: number;
  private readonly pauseMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly keys = new Map<string, KeyState>();

  constructor(options: RequestBudgetOptions = {}) {
    this.perMinute = options.perMinute ?? 200;
    this.backgroundPerMinute = options.backgroundPerMinute ?? 60;
    this.reserve = options.reserve ?? 80;
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
  async take(key: string, background: boolean): Promise<void> {
    for (;;) {
      const s = this.state(key);
      const now = this.now();
      if (!background) {
        s.sent.push({ at: now, background });
        return;
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
    return Math.max(
      until(s.sent, Math.max(1, this.perMinute - this.reserve)),
      until(bg, Math.max(1, this.backgroundPerMinute)),
    );
  }

  /** Alpaca throttled the key: background requests stand aside until it says, or a minute. */
  throttled(key: string, retryAfterMs: number | undefined): void {
    const s = this.state(key);
    s.pausedUntil = Math.max(s.pausedUntil, this.now() + (retryAfterMs ?? this.pauseMs));
  }

  /** Tests: how many requests the key sent in the last minute. */
  sentLastMinute(key: string): number {
    return this.state(key).sent.length;
  }
}

/** The budget every Alpaca client in this process shares, per key. */
export const sharedAlpacaBudget = new AlpacaRequestBudget();
