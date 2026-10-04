import { resolveIncidentRequest } from '@tm/contracts';
import { getExecutionStatus, resolveIncident } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** A person marks an incident as dealt with (§8.5). Paused strategies stay paused. */
export const POST = api<{ incidentId: string }>(async (request, { tx, userId }, { incidentId }) => {
  const { note } = await readJson(request, resolveIncidentRequest);
  return Response.json(
    await tx(async (t) => {
      await resolveIncident(t, { userId, incidentId, by: 'user', note });
      return getExecutionStatus(t);
    }),
  );
});
