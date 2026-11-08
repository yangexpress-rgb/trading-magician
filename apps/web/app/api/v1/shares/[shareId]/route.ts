import { getShare } from '@tm/db';
import { api, errorResponse } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** One share with its snapshot, for its sender or recipient only. */
export const GET = api<{ shareId: string }>(async (_request, { tx, userId }, { shareId }) => {
  const share = await tx((t) => getShare(t, userId, shareId));
  if (!share) return errorResponse('not_found', 'Share not found');
  return Response.json(share);
});
