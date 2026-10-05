import { updateAccountRequest } from '@tm/contracts';
import { updateAccount } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const PATCH = api<{ accountId: string }>(async (request, { userId, tx }, { accountId }) => {
  const input = await readJson(request, updateAccountRequest);
  return Response.json(await tx((t) => updateAccount(t, { userId, id: accountId, ...input })));
});
