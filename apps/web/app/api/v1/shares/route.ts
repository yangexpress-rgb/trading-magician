import { createShares, createShareSchema, listShares, SHARE_STATUSES } from '@tm/db';
import { z } from 'zod';
import { api, readJson, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

const listQuery = z.object({
  box: z.enum(['received', 'sent']).default('received'),
  status: z.enum(SHARE_STATUSES).optional(),
});

/** Shares sent to (or by) the signed-in person, newest first (ADR 0056). */
export const GET = api(async (request, { tx, userId }) => {
  const q = readQuery(request, listQuery);
  const items = await tx((t) => listShares(t, userId, { box: q.box, status: q.status }));
  return Response.json({ items });
});

/** Shares a Library record or one of your strategies with one or more members. */
export const POST = api(async (request, { tx, userId }) => {
  const body = await readJson(request, createShareSchema);
  const items = await tx((t) => createShares(t, userId, body));
  return Response.json({ items }, { status: 201 });
});
