import { performanceQuery } from '@tm/contracts';
import type { PerformanceFilter } from '@tm/db';
import { readQuery } from '@/lib/server/api';

/** The shared performance filters from a request's query string (§10.1, §14.3). */
export function readPerformanceFilter(request: Request): PerformanceFilter {
  const q = readQuery(request, performanceQuery);
  return {
    from: q.from,
    to: q.to,
    accountIds: q.accountId,
    strategyIds: q.strategyId,
    versionIds: q.versionId,
    instrumentIds: q.instrumentId,
    assetClasses: q.assetClass,
    mode: q.mode,
  };
}
