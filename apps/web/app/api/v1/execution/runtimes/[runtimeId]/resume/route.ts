import { resumeRuntimeByUser } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const POST = api<{ runtimeId: string }>(async (_request, { tx, userId }, { runtimeId }) =>
  Response.json(await tx((t) => resumeRuntimeByUser(t, userId, runtimeId))),
);
