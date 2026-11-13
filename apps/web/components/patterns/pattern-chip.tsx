import type { PatternChip as Chip } from '@tm/domain';
import { Badge, type Tone } from '@tm/ui';

const TONE: Record<Chip, Tone> = {
  Candidate: 'neutral',
  Verified: 'ok',
  Holding: 'ok',
  Weakening: 'warn',
  Broken: 'danger',
};

export function PatternChip({ chip }: { chip: Chip }) {
  return <Badge tone={TONE[chip]}>{chip}</Badge>;
}
