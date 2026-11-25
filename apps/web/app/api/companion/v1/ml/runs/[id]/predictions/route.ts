import { handleRunPredictions } from '@/lib/server/companion/api';
import { appDb } from '@/lib/server/db';
import { logger } from '@/lib/server/log';

export const dynamic = 'force-dynamic';

/** Local Companion API (ADR 0117): one model run's predictions. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    return await handleRunPredictions(request, { db: appDb() }, id);
  } catch (err) {
    logger().error({ err }, 'Companion request failed');
    return Response.json(
      { error: { code: 'internal', message: 'Something went wrong. Try again.' } },
      { status: 500 },
    );
  }
}
