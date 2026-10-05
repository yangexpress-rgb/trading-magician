import { requestFeedCheck } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker to check the feed; the page updates live when it has. */
export const POST = api<{ feedId: string }>(async (_request, { tx }, { feedId }) =>
  Response.json(await tx((t) => requestFeedCheck(t, feedId)), { status: 202 }),
);
