import { listHeartbeats } from '@tm/db';
import { appDb } from '@/lib/server/db';
import { logger } from '@/lib/server/log';
import { systemHealth } from '@/lib/system-health';

export const dynamic = 'force-dynamic';

/**
 * For the uptime monitor (ADR 0025): 200 when the database answers and the
 * worker is alive, else 503. Public, and says nothing about anyone's data.
 */
export async function GET() {
  let beats: Awaited<ReturnType<typeof listHeartbeats>> | null;
  try {
    beats = await listHeartbeats(appDb());
  } catch (error) {
    logger().error({ err: error }, 'Health check could not reach the database');
    beats = null;
  }
  const body = systemHealth(beats, new Date());
  return Response.json(body, {
    status: body.status === 'ok' ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
