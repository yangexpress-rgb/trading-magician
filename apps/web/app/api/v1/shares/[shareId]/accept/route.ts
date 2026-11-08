import { acceptShare } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Accepts a share: makes the copy, with a new number, in your Library or Strategy Lab. */
export const POST = api<{ shareId: string }>(async (_request, { tx, userId }, { shareId }) => {
  const result = await tx((t) => acceptShare(t, userId, shareId));
  return Response.json(result);
});
