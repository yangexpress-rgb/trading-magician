import { accountFeedsRequest } from '@tm/contracts';
import { getAccount, setAccountFeeds } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * An account's own data feeds (ADR 0108): a primary and fallbacks in order,
 * and what its runs do when the feed pricing them stops. An empty list goes
 * back to the data routes.
 */
export const PUT = api<{ accountId: string }>(async (request, { userId, tx }, { accountId }) => {
  const body = await readJson(request, accountFeedsRequest);
  return Response.json(
    await tx(async (t) => {
      await setAccountFeeds(t, userId, accountId, body);
      return getAccount(t, accountId);
    }),
  );
});
