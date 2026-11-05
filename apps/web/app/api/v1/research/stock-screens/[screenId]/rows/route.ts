import { getStockScreenData } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** The screen with every row: about a megabyte for the whole US market, fetched once. */
export const GET = api<{ screenId: string }>(async (_request, { tx }, { screenId }) =>
  Response.json(await tx((t) => getStockScreenData(t, screenId))),
);
