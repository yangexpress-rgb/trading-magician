import { accountPilotRequest } from '@tm/contracts';
import { endPilotMode, getAccount, setAccountPilot } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * A live account's pilot mode (ADR 0109): change its caps within the ceiling, or end it on
 * purpose. Paper accounts have none.
 */
export const PUT = api<{ accountId: string }>(async (request, { userId, tx }, { accountId }) => {
  const body = await readJson(request, accountPilotRequest);
  return Response.json(
    await tx(async (t) => {
      if ('endPilot' in body) await endPilotMode(t, userId, accountId);
      else await setAccountPilot(t, userId, accountId, body);
      return getAccount(t, accountId);
    }),
  );
});
