import type { DealListDto } from '@tm/contracts';
import { latestRecordedCloses, listDeals, listScanStates } from '@tm/db';
import { dealSpread } from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** The deals the app's EDGAR tracker found (ADR 0058); active ones unless `?all=1`. */
export const GET = api(async (request, { tx }) => {
  const all = new URL(request.url).searchParams.get('all') === '1';
  const body = await tx(async (t): Promise<DealListDto> => {
    const [deals, states] = await Promise.all([listDeals(t, { active: !all }), listScanStates(t)]);
    const symbols = [...new Set(deals.flatMap((d) => (d.targetSymbol ? [d.targetSymbol] : [])))];
    const closes = await latestRecordedCloses(t, symbols);
    return {
      deals: deals.map((d) => {
        const c = d.targetSymbol ? closes.get(d.targetSymbol) : undefined;
        const spread = c
          ? dealSpread(
              {
                dealId: d.dealId,
                announcedAt: d.announcedAt,
                offerPrice: d.offerPrice,
                confidence: d.confidence,
                changes: [],
              },
              c.close,
            )
          : undefined;
        return {
          dealId: d.dealId,
          targetSymbol: d.targetSymbol,
          targetName: d.targetName,
          acquirerName: d.acquirerName,
          announcedDate: d.announcedDate,
          offerPrice: d.offerPrice,
          consideration: d.consideration,
          status: d.status,
          confidence: d.confidence,
          parseNote: d.parseNote,
          sourceFilingUrl: d.sourceFilingUrl,
          close: c?.close ?? null,
          closeDate: c?.date ?? null,
          spreadPct: spread ?? null,
        };
      }),
      scan: states
        .filter((x) => x.job.startsWith('deals'))
        .map((x) => ({
          job: x.job,
          status: x.status,
          coveredFrom: x.coveredFrom,
          coveredTo: x.coveredTo,
          lastOkAt: x.lastOkAt?.toISOString() ?? null,
          note: x.note,
        })),
    };
  });
  return Response.json(body);
});
