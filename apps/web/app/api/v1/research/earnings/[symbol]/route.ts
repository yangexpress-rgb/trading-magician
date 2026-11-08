import type { EarningsDto, EventJobStatusDto } from '@tm/contracts';
import { listScanStates, nextScheduled, normaliseOptionSymbol, recentReleases } from '@tm/db';
import { nyDate } from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** A symbol's latest earnings releases with SUE and its next scheduled date (ADR 0058). */
export const GET = api<{ symbol: string }>(async (_request, { tx }, { symbol }) => {
  const s = normaliseOptionSymbol(symbol);
  const body = await tx(async (t): Promise<EarningsDto> => {
    const [releases, next, states] = await Promise.all([
      recentReleases(t, s, 8),
      nextScheduled(t, s, nyDate(new Date())),
      listScanStates(t),
    ]);
    const calendarState = states.find((x) => x.job === 'calendar');
    return {
      symbol: s,
      releases,
      next: next ? { date: next.date, timeHint: next.timeHint, provider: next.provider } : null,
      calendar: calendarState?.status === 'done' ? 'on' : 'edgar_only',
      scan: states.filter((x) => x.job.startsWith('earnings') || x.job === 'calendar').map(jobDto),
    };
  });
  return Response.json(body);
});

function jobDto(x: Awaited<ReturnType<typeof listScanStates>>[number]): EventJobStatusDto {
  return {
    job: x.job,
    status: x.status,
    coveredFrom: x.coveredFrom,
    coveredTo: x.coveredTo,
    lastOkAt: x.lastOkAt?.toISOString() ?? null,
    note: x.note,
  };
}
