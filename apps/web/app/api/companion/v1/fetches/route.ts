import { handleFetch } from '@/lib/server/companion/api';
import { appDb } from '@/lib/server/db';
import { logger } from '@/lib/server/log';

export const dynamic = 'force-dynamic';

/** Local Companion API (ADR 0118): ask the cloud for members, bars, filings or earnings. */
export async function POST(request: Request): Promise<Response> {
  try {
    return await handleFetch(request, { db: appDb() });
  } catch (err) {
    logger().error({ err }, 'Companion request failed');
    return Response.json(
      { error: { code: 'internal', message: 'Something went wrong. Try again.' } },
      { status: 500 },
    );
  }
}
