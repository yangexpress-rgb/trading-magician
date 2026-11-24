import { listBacktestTrades } from '@tm/db';
import { api } from '@/lib/server/api';
import { researchFor } from '@/lib/server/db';

export const dynamic = 'force-dynamic';

// Trades are read from the Research Store (ADR 0115), after Core confirms the run is theirs.
export const GET = api<{ runId: string }>(async (_request, { tx, userId }, { runId }) =>
  Response.json({
    trades: await tx((t) => listBacktestTrades(t, runId, researchFor({ userId }))),
  }),
);
