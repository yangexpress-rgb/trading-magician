import { getPriceChart } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ chartId: string }>(async (_request, { tx }, { chartId }) =>
  Response.json(await tx((t) => getPriceChart(t, chartId))),
);
