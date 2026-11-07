import { getLiveChain, IntegrationError } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ symbol: string }>(async (_request, { tx }, { symbol }) => {
  const chain = await tx((t) => getLiveChain(t, symbol));
  if (!chain) throw new IntegrationError('not_found', 'No option chain has been asked for');
  return Response.json(chain);
});
