import { lookupShareMember } from '@tm/db';
import { z } from 'zod';
import { api, readQuery } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * One member by exact member ID or email, to confirm a share's recipient
 * (ADR 0056). The same empty answer for everyone who can't receive shares.
 */
export const GET = api(async (request, { tx }) => {
  const { q } = readQuery(request, z.object({ q: z.string().max(320).default('') }));
  const member = await tx((t) => lookupShareMember(t, q));
  return Response.json({
    member: member
      ? { memberCode: member.memberCode, displayName: member.displayName, isAdmin: member.isAdmin }
      : null,
  });
});
