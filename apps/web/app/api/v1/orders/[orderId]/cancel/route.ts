import { cancelOrderByUser } from '@tm/db';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** A person's cancel (§14.3); the runtime sends it to the broker on its next pass. */
export const POST = api<{ orderId: string }>(async (_request, { tx, userId }, { orderId }) =>
  Response.json(await tx((t) => cancelOrderByUser(t, userId, orderId))),
);
