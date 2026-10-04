import { cancelBacktest } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ runId: string }>(async (_request, { tx, userId }, { runId }) =>
  Response.json(await tx((t) => cancelBacktest(t, userId, runId))),
);
