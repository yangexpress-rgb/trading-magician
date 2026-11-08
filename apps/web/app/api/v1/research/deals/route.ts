import type { DealListDto } from '@tm/contracts';
import { listDealFilings, listDeals, listScanStates } from '@tm/db';
import { dealSpread } from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** The deals the app's EDGAR tracker found (ADR 0058); active ones unless `?all=1`. */
export const GET = api(async (request, { tx }) => {
  const all = new URL(request.url).searchParams.get('all') === '1';
  const body = await tx(async (t): Promise<DealListDto> => {
    const [deals, states] = await Promise.all([listDeals(t, { active: !all }), listScanStates(t)]);
    // Closes come from the targets' daily bars, stored by the worker each evening (N151).
    const filings = await listDealFilings(t, deals);
    return {
      deals: deals.map((d) => {
        const spread =
          d.lastClose !== null
            ? dealSpread(
                {
                  dealId: d.dealId,
                  announcedAt: d.announcedAt,
                  offerPrice: d.offerPrice,
                  confidence: d.confidence,
                  changes: [],
                },
                d.lastClose,
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
          filings: filings.get(d.dealId) ?? [],
          close: d.lastClose,
          closeDate: d.lastCloseDate,
          spreadPct: spread ?? null,
        };
      }),
      scan: states
        .filter((x) => x.job.startsWith('deal'))
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
