import { markNotificationsReadRequest } from '@tm/contracts';
import { markNotificationsRead } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api(async (request, { tx }) => {
  const body = await readJson(request, markNotificationsReadRequest);
  const marked = await tx((t) => markNotificationsRead(t, 'all' in body ? 'all' : body.ids));
  return Response.json({ marked });
});
