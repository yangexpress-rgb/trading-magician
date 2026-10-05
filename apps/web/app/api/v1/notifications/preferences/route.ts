import { updateNotificationPrefsRequest } from '@tm/contracts';
import { getNotificationPrefs, updateNotificationPrefs } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) => Response.json(await tx(getNotificationPrefs)));

export const PUT = api(async (request, { userId, tx }) => {
  const { muted } = await readJson(request, updateNotificationPrefsRequest);
  return Response.json(await tx((t) => updateNotificationPrefs(t, { userId, muted })));
});
