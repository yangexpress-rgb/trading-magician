import { startStrategyRequest } from '@tm/contracts';
import { recordLiveRefusal, startStrategy, StrategyError } from '@tm/db';
import { api, readJson } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** Refusals of the live gate are kept in the audit trail (ADR 0109, A7). */
const LIVE_REASONS = new Set(['live_disabled', 'live_feed_delayed', 'live_unconfirmed']);

/**
 * Starts the strategy as a run on one account (N308): paper, or live behind the live gate
 * with its own confirmation (ADR 0109).
 */
export const POST = api<{ id: string }>(async (request, { tx, userId }, { id }) => {
  const body = await readJson(request, startStrategyRequest);
  try {
    return Response.json(
      await tx((t) =>
        startStrategy(t, userId, id, {
          rowVersion: body.rowVersion,
          confirmed: body.confirmed,
          acknowledgedWarnings: body.acknowledgedWarnings,
          accountId: body.accountId,
          mode: body.mode,
          liveConfirmed: body.liveConfirmed,
        }),
      ),
    );
  } catch (error) {
    const reason =
      error instanceof StrategyError
        ? (error.details as { reason?: string } | undefined)?.reason
        : undefined;
    if (error instanceof StrategyError && reason && LIVE_REASONS.has(reason)) {
      await tx((t) =>
        recordLiveRefusal(t, {
          userId,
          strategyId: id,
          accountId: body.accountId,
          reason,
          message: error.message,
        }),
      );
    }
    throw error;
  }
});
