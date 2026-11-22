import { accountKillSwitchRequest } from '@tm/contracts';
import { setAccountKillSwitch } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * The account kill switch (ADR 0107): engaging it pauses every run on the
 * account and cancels its working orders; releasing it ends the account's
 * halt and resumes nothing. Other accounts are untouched.
 */
export const POST = api<{ accountId: string }>(async (request, { userId, tx }, { accountId }) => {
  const { engaged, reason } = await readJson(request, accountKillSwitchRequest);
  return Response.json(
    await tx((t) => setAccountKillSwitch(t, userId, accountId, engaged, reason)),
  );
});
