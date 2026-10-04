import { listPositions } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api(async (_request, { tx }) =>
  Response.json({ positions: await tx((t) => listPositions(t)) }),
);
