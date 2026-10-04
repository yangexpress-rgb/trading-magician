import { getOrderDetail } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

export const GET = api<{ orderId: string }>(async (_request, { tx }, { orderId }) =>
  Response.json(await tx((t) => getOrderDetail(t, orderId))),
);
