import { getCompanyReport } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ reportId: string }>(async (_request, { tx }, { reportId }) =>
  Response.json(await tx((t) => getCompanyReport(t, reportId))),
);
