import { getScanState, type FeedCheckResult } from '@tm/db';
import type { ProviderContext } from '../providers';

/**
 * An earnings calendar feed's health (ADR 0058). The worker fetches the
 * calendar once a night for everyone, so a feed check never calls FMP or
 * Finnhub (their free tiers allow few calls a day): it reports how the last
 * nightly fetch went, and whether it used this provider.
 */
export interface EarningsFeedProvider {
  needsCredential: false;
  check(ctx: ProviderContext): Promise<FeedCheckResult>;
}

const DAY = 86_400_000;

export function earningsFeedProvider(provider: 'fmp' | 'finnhub'): EarningsFeedProvider {
  return {
    needsCredential: false,
    async check(ctx) {
      if (!ctx.inTenant)
        return { ok: false, entitlement: 'unknown', error: 'Cannot be checked here' };
      const state = await ctx.inTenant((tx) => getScanState(tx, 'calendar'));
      const now = ctx.now().getTime();
      if (!state || !state.lastRunAt)
        return {
          ok: false,
          entitlement: 'unknown',
          realtime: false,
          error: 'The nightly calendar fetch has not run yet (it runs after 18:30 New York)',
        };
      if (state.status === 'failed')
        return {
          ok: false,
          entitlement: 'unknown',
          realtime: false,
          error: `The last nightly fetch failed: ${state.lastError ?? 'no reason given'}`,
        };
      if (state.status === 'skipped')
        return {
          ok: false,
          entitlement: 'unknown',
          realtime: false,
          error:
            'The worker runs in EDGAR-only mode: the key it uses is a platform admin’s, or the calendar is switched off',
        };
      const fresh = state.lastOkAt && now - state.lastOkAt.getTime() < 2 * DAY;
      if (!fresh)
        return {
          ok: false,
          entitlement: 'entitled',
          realtime: false,
          error: 'No calendar has been fetched for two days',
        };
      // Healthy whichever provider answered: the other is the fallback (brief §5.1).
      void provider;
      return { ok: true, entitlement: 'entitled', realtime: false };
    },
  };
}
