/**
 * Automatic resume after a passing outage (N281, ADR 0097).
 *
 * A strategy paused because the broker stopped answering, Alpaca throttled the
 * key, or live prices were lost resumes on its own once the cause has cleared
 * and stayed clear: after a wait that grows with each resume that day (1, 3,
 * then 10 minutes) and with the cause healthy for 30 s. After 3 resumes in one
 * New York day it stays paused for a person. Pauses that need a person to look
 * (reconciliation, repeated rejects, a manual or kill-switch pause, plan
 * changes) never resume on their own.
 */

export const AUTO_RESUME = {
  delaysMs: [60_000, 180_000, 600_000],
  perDay: 3,
  healthyForMs: 30_000,
} as const;

export type AutoPauseKind = 'broker_disconnected' | 'broker_throttled' | 'feed_loss';

export interface AutoPause {
  kind: AutoPauseKind;
  /** The pause reason the runtime was given; anything else means another pause took over. */
  reason: string;
  /** When it paused, epoch ms. */
  at: number;
  /** Since when the cause has been clear, epoch ms. */
  healthySince?: number | undefined;
  /** The daily cap was reached and the person was told. */
  gaveUp?: boolean | undefined;
}

export interface AutoResumeCount {
  /** New York date. */
  day: string;
  count: number;
}

export type AutoResumeStep =
  | { action: 'wait'; pause: AutoPause }
  | { action: 'resume'; count: AutoResumeCount; attempt: number }
  | { action: 'give_up'; pause: AutoPause };

export function autoResumeStep(input: {
  pause: AutoPause;
  counts: AutoResumeCount | undefined;
  today: string;
  healthy: boolean;
  now: number;
}): AutoResumeStep {
  const { pause, today, now } = input;
  const used = input.counts?.day === today ? input.counts.count : 0;
  if (used >= AUTO_RESUME.perDay) {
    return pause.gaveUp
      ? { action: 'wait', pause }
      : { action: 'give_up', pause: { ...pause, gaveUp: true } };
  }
  const healthySince = input.healthy ? (pause.healthySince ?? now) : undefined;
  const next = { ...pause, healthySince };
  const delay = AUTO_RESUME.delaysMs[Math.min(used, AUTO_RESUME.delaysMs.length - 1)]!;
  if (
    healthySince !== undefined &&
    now - pause.at >= delay &&
    now - healthySince >= AUTO_RESUME.healthyForMs
  ) {
    return { action: 'resume', count: { day: today, count: used + 1 }, attempt: used + 1 };
  }
  return { action: 'wait', pause: next };
}
