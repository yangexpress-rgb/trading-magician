import type { StrategyRunStateDto } from '@tm/contracts';
import { Badge } from '@tm/ui';
import Link from 'next/link';

/**
 * A strategy's paper run beside its business status (N286). "Actively executing"
 * stays the status while a run is paused, so a pause must show next to it, with
 * the reason the Orders banner and the pause notification give.
 */
export function RunStateBadge({ run }: { run: Pick<StrategyRunStateDto, 'status'> | null }) {
  if (run?.status !== 'paused') return null;
  return <Badge tone="warn">Paused</Badge>;
}

/** The Strategy Lab list's status cell: the status, then Paused and why (N286). */
export function PausedNote({
  strategyId,
  run,
}: {
  strategyId: string;
  run: Pick<StrategyRunStateDto, 'status' | 'pauseReason'> | null;
}) {
  if (run?.status !== 'paused') return null;
  return (
    <p className="mt-1 max-w-64 text-xs text-warn">
      <span className="font-semibold">Paused.</span> {run.pauseReason ?? 'No reason was recorded.'}{' '}
      <Link href={`/orders?strategy=${strategyId}`} className="underline">
        Resume in Orders
      </Link>
    </p>
  );
}
