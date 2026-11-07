import { listOptionUniverse, type FeedCheckResult } from '@tm/db';
import { addDays, nyDate, regularSession, tradingDaysBetween } from '@tm/domain';
import type { ProviderContext } from '../providers';

/**
 * The options feed's health (options data brief v2 §5.1): the recording is
 * global, so a tenant's "CBOE delayed options (daily)" feed is healthy while
 * the worker keeps storing snapshots. It shows Down once no underlying has
 * been stored for 3 trading days running; one failing underlying does not
 * take it down (Settings lists it). The data is delayed, never real time.
 */
export interface OptionsFeedProvider {
  needsCredential: false;
  check(ctx: ProviderContext): Promise<FeedCheckResult>;
}

/** Sessions that must pass without a stored snapshot before the feed is down. */
export const OPTIONS_DOWN_AFTER_SESSIONS = 3;

/** The latest trading day whose session has closed by `now`. */
function lastClosedSession(now: Date): string {
  let d = nyDate(now);
  for (let i = 0; i < 10; i++, d = addDays(d, -1)) {
    const s = regularSession(d);
    if (s && Date.parse(s.close) <= now.getTime()) return d;
  }
  return d;
}

export function optionsFeedProvider(): OptionsFeedProvider {
  return {
    needsCredential: false,
    async check(ctx) {
      if (!ctx.inTenant)
        return { ok: false, entitlement: 'unknown', error: 'Cannot be checked here' };
      const universe = await ctx.inTenant((tx) => listOptionUniverse(tx));
      const now = ctx.now();
      if (universe.length === 0)
        return {
          ok: false,
          entitlement: 'unknown',
          realtime: false,
          error: 'No underlyings are being recorded yet',
        };
      const latest = universe
        .map((u) => u.lastSnapshotDate)
        .filter((d): d is string => d !== null)
        .sort()
        .at(-1);
      const closed = lastClosedSession(now);
      const since =
        latest ?? nyDate(universe.map((u) => u.addedAt).sort((a, b) => +a - +b)[0] ?? now);
      if (tradingDaysBetween(since, closed) >= OPTIONS_DOWN_AFTER_SESSIONS) {
        return {
          ok: false,
          entitlement: 'entitled',
          realtime: false,
          error: latest
            ? `No options snapshot has been stored since ${latest}`
            : 'No options snapshot has been stored yet',
        };
      }
      return { ok: true, entitlement: 'entitled', realtime: false };
    },
  };
}
