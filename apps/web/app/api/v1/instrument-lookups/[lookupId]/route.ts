import { getInstrumentLookup } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ lookupId: string }>(async (_request, { tx }, { lookupId }) =>
  Response.json(await tx((t) => getInstrumentLookup(t, lookupId))),
);
