import { validateStoredStrategy } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Validates the saved draft against the tenant's current accounts and feeds (§6.10), including
 * whether the latest back test matches it (§7.4). With `?accountId=`, it checks the rules as a run
 * on that account, as Start does, so the Start dialog shows that account's warnings (N398). */
export const POST = api<{ id: string }>(async (request, { tx }, { id }) => {
  const accountId = new URL(request.url).searchParams.get('accountId') ?? undefined;
  const { validation, definitionHash, backtest } = await tx((t) =>
    validateStoredStrategy(t, id, accountId),
  );
  return Response.json({ ...validation, definitionHash, latestBacktest: backtest });
});
