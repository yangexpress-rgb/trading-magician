import { createCompanyReportRequest } from '@tm/contracts';
import { requestCompanyReport } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker for a company's profile, financials and filings (ADR 0031). */
export const POST = api(async (request, { userId, tx }) => {
  const body = await readJson(request, createCompanyReportRequest);
  return Response.json(
    await tx((t) => requestCompanyReport(t, { userId, symbol: body.symbol, fresh: body.fresh })),
    { status: 202 },
  );
});
