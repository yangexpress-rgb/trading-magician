import type { Tone } from '@tm/ui';

/** Strategy sharing (ADR 0056) in the person's words. */
export const SHARE_STATUS_LABELS = {
  pending: { label: 'Waiting for an answer', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'ok' },
  declined: { label: 'Declined', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: Tone }>;

export const SHARE_KIND_LABELS = {
  library: 'Library record',
  lab: 'Strategy Lab strategy',
} as const;
