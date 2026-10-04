import { getBacktest } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ runId: string }>(async (_request, { tx }, { runId }) =>
  Response.json(await tx((t) => getBacktest(t, runId))),
);
