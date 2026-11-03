import { getStockScreen } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ screenId: string }>(async (_request, { tx }, { screenId }) =>
  Response.json(await tx((t) => getStockScreen(t, screenId))),
);
