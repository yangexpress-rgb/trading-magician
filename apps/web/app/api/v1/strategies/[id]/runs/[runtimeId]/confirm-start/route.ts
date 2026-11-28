import { confirmMachineStart, MachineStartError } from '@tm/db';
import { api, HttpError } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * Confirms a state machine's Start after its replay (ADR 0124 P3a, §2.9): the
 * run adopts the replayed state and places its Start rebalance on the next pass.
 */
export const POST = api<{ id: string; runtimeId: string }>(
  async (_request, { tx }, { id, runtimeId }) => {
    try {
      const m = await tx((t) => confirmMachineStart(t, runtimeId, new Date(), id));
      return Response.json({ confirmedAt: m.confirmedAt });
    } catch (e) {
      if (e instanceof MachineStartError)
        throw new HttpError(e.code === 'not_found' ? 'not_found' : 'invalid_state', e.message);
      throw e;
    }
  },
);
