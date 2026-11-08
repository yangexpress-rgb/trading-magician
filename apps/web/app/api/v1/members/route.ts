import { listShareMembers } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Every member who can receive shares: the admin's recipient picker only. */
export const GET = api(async (_request, { tx }) => {
  const items = await tx((t) => listShareMembers(t));
  return Response.json({
    items: items.map((m) => ({
      memberCode: m.memberCode,
      displayName: m.displayName,
      isAdmin: m.isAdmin,
    })),
  });
});
