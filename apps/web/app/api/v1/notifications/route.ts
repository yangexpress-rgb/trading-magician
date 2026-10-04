import { listNotificationsQuery } from '@tm/contracts';
import { listNotifications } from '@tm/db';
import { api, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (request, { tx }) => {
  const { unread, limit } = readQuery(request, listNotificationsQuery);
  return Response.json(
    await tx((t) => listNotifications(t, { limit, unreadOnly: unread === 'true' })),
  );
});
