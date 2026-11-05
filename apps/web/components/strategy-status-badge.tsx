import { STATUS_LABELS, type StrategyStatus } from '@tm/domain';
import { Badge, type Tone } from '@tm/ui';

const TONES: Record<StrategyStatus, Tone> = {
  created: 'neutral',
  under_testing: 'info',
  actively_executing: 'ok',
  off: 'warn',
};

/** Business status (§6.3), always as text plus icon. */
export function StrategyStatusBadge({ status }: { status: StrategyStatus }) {
  return <Badge tone={TONES[status]}>{STATUS_LABELS[status]}</Badge>;
}
