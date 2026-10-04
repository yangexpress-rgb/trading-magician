import { validateStoredStrategy } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Validates the saved draft against the tenant's current accounts and feeds (§6.10), including
 * whether the latest back test matches it (§7.4). */
export const POST = api<{ id: string }>(async (_request, { tx }, { id }) => {
  const { validation, definitionHash, backtest } = await tx((t) => validateStoredStrategy(t, id));
  return Response.json({ ...validation, definitionHash, latestBacktest: backtest });
});
