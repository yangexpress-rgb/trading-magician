import { setFeedSharingRequest } from '@tm/contracts';
import { adminFeedSharing, adminSetFeedSharing, isPlatformAdmin } from '@tm/db';
import { api, HttpError, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** An admin shares their data feeds with members, or stops (N237, ADR 0084). */
export const PUT = api(async (request, { tx }) => {
  const input = await readJson(request, setFeedSharingRequest);
  return Response.json(
    await tx(async (t) => {
      // The database checks again and audits the change.
      if (!(await isPlatformAdmin(t))) throw new HttpError('not_found', 'Not found');
      await adminSetFeedSharing(t, input.on);
      return { sharing: await adminFeedSharing(t) };
    }),
  );
});
