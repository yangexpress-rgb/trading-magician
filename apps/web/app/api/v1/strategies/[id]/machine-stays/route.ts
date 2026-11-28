import type { MachineStaysDto } from '@tm/contracts';
import { getStrategy, machineStays } from '@tm/db';
import { nyDate } from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/** A state machine's stays on paper, run by run (state-machine brief v1.4 §2.6, ADR 0124 P3b). */
export const GET = api<{ id: string }>(async (_request, { tx }, { id }) =>
  Response.json(
    await tx(async (t): Promise<MachineStaysDto> => {
      const s = await getStrategy(t, id);
      const today = nyDate(new Date());
      const runs = [];
      for (const r of s.runs) {
        const stays = await machineStays(t, r.runtimeId, today);
        if (stays.length > 0)
          runs.push({
            runtimeId: r.runtimeId,
            accountName: r.accountName,
            stays: stays.map((x) => ({ ...x, returnPct: null })),
          });
      }
      return {
        states:
          s.machine?.machine.states.map(({ id: stateId, name }) => ({ id: stateId, name })) ?? [],
        runs,
      };
    }),
  ),
);
