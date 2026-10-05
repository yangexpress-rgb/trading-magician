import { getPlatform } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ brokerId: string }>(async (_request, { tx }, { brokerId }) =>
  Response.json((await tx((t) => getPlatform(t, brokerId))).accounts),
);
