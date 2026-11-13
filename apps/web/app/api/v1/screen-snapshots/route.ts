import { saveScreenSnapshot } from '@tm/db';
import { saveSnapshotRequest } from '@/lib/ask-ai';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * Saves what the Ask AI panel saw (N272, ADR 0093) and returns the code an
 * agent passes to get_screen_context.
 */
export const POST = api(async (request, { tx, userId }) => {
  const body = await readJson(request, saveSnapshotRequest);
  const snap = await tx((t) => saveScreenSnapshot(t, userId, body));
  return Response.json({ code: snap.code, expiresAt: snap.expiresAt }, { status: 201 });
});
