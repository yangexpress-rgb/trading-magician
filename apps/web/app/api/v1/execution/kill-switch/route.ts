import { killSwitchRequest } from '@tm/contracts';
import { setKillSwitchByUser } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Pauses every strategy's new orders, or releases the pause (§8.1). Cancels nothing. */
export const POST = api(async (request, { tx, userId }) => {
  const { engaged, reason } = await readJson(request, killSwitchRequest);
  return Response.json(await tx((t) => setKillSwitchByUser(t, userId, engaged, reason)));
});
