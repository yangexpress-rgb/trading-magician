import { handlePush, handlePushes } from '@/lib/server/companion/api';
import { appDb } from '@/lib/server/db';
import { logger } from '@/lib/server/log';

export const dynamic = 'force-dynamic';

const failed = (err: unknown) => {
  logger().error({ err }, 'Companion request failed');
  return Response.json(
    { error: { code: 'internal', message: 'Something went wrong. Try again.' } },
    { status: 500 },
  );
};

/** Local Companion API (ADR 0117): queue a Frozen Output for the worker to apply. */
export async function POST(request: Request): Promise<Response> {
  try {
    return await handlePush(request, { db: appDb() });
  } catch (err) {
    return failed(err);
  }
}

/** Local Companion API (ADR 0117): this companion's pushes and how applying went. */
export async function GET(request: Request): Promise<Response> {
  try {
    return await handlePushes(request, { db: appDb() });
  } catch (err) {
    return failed(err);
  }
}
