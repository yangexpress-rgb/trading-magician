import { requestPlatformCheck } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Asks the worker to check the platform and rediscover its accounts; the page updates live. */
export const POST = api<{ brokerId: string }>(async (_request, { tx }, { brokerId }) =>
  Response.json(await tx((t) => requestPlatformCheck(t, brokerId)), { status: 202 }),
);
