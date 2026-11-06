import { getCustomFeedTest } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ testId: string }>(async (_request, { tx }, { testId }) =>
  Response.json(await tx((t) => getCustomFeedTest(t, testId))),
);
