import { declineShare } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ shareId: string }>(async (_request, { tx }, { shareId }) => {
  await tx((t) => declineShare(t, shareId));
  return new Response(null, { status: 204 });
});
