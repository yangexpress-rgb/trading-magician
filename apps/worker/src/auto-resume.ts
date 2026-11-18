/**
 * Automatic resume after a passing outage (N283, ADR 0097).
 *
 * A strategy paused because the broker stopped answering, Alpaca throttled the
 * key, or live prices were lost resumes on its own once the cause has cleared
 * and stayed clear: after a wait that grows with each resume that day (1, 3,
 * then 10 minutes) and with the cause healthy for 30 s. After 3 resumes in one
 * New York day it stays paused for a person. A manual or kill-switch pause and
 * a plan change never resume on their own.
 *
 * N301 (ADR 0103) adds two more: a reconciliation mismatch resumes the same
 * way once a later reconciliation of its account comes back clean (sharing
 * the daily count), and repeated rejects retry at the next regular session's
 * open, at most twice in a row without an order filling in between.
 */

import { nextTradingDay, nyDate, regularSession } from '@tm/domain';

export const AUTO_RESUME = {
  delaysMs: [60_000, 180_000, 600_000],
  perDay: 3,
  healthyForMs: 30_000,
} as const;

export type AutoPauseKind =
  | 'broker_disconnected'
  | 'broker_throttled'
  | 'feed_loss'
  | 'reconciliation_mismatch'
  | 'repeated_rejects';

/** Retries after repeated rejects in a row, with no fill between, before a person must look (N301). */
export const REJECT_RETRIES = 2;

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
  const delays: readonly number[] = AUTO_RESUME.delaysMs;
  const delay = delays[Math.min(used, delays.length - 1)] ?? 0;
  if (
    healthySince !== undefined &&
    now - pause.at >= delay &&
    now - healthySince >= AUTO_RESUME.healthyForMs
  ) {
    return { action: 'resume', count: { day: today, count: used + 1 }, attempt: used + 1 };
  }
  return { action: 'wait', pause: next };
}

/** The first regular session open after `t`, epoch ms (N301). */
export function nextOpenAfter(t: number): number | undefined {
  let day = nyDate(new Date(t));
  for (let i = 0; i < 10; i++) {
    const session = regularSession(day);
    if (session && Date.parse(session.open) > t) return Date.parse(session.open);
    day = nextTradingDay(day);
  }
  return undefined;
}

/**
 * Repeated rejects (N301): wait for the next regular session's open after the
 * pause, then retry, unless the strategy already retried `REJECT_RETRIES`
 * times in a row without an order filling.
 */
export function rejectsResumeStep(input: {
  pause: AutoPause;
  retries: number;
  blocked: boolean;
  now: number;
}): AutoResumeStep {
  const { pause, now } = input;
  if (input.retries >= REJECT_RETRIES) {
    return pause.gaveUp
      ? { action: 'wait', pause }
      : { action: 'give_up', pause: { ...pause, gaveUp: true } };
  }
  const due = nextOpenAfter(pause.at);
  if (input.blocked || due === undefined || now < due) return { action: 'wait', pause };
  const session = regularSession(nyDate(new Date(now)));
  if (!session || now >= Date.parse(session.close)) return { action: 'wait', pause };
  return {
    action: 'resume',
    count: { day: nyDate(new Date(now)), count: input.retries + 1 },
    attempt: input.retries + 1,
  };
}
