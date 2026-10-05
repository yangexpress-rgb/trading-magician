import {
  COUNT_LIMITS,
  FEATURE_LIMITS,
  LIMIT_LABELS,
  type CountLimit,
  type PlanLimits,
} from '@tm/domain';

/** Words for Settings › Subscription and billing (ADR 0022). */

export function formatPrice(priceMinor: number, currency: string, interval: string): string {
  if (priceMinor === 0) return 'Free';
  const amount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: priceMinor % 100 === 0 ? 0 : 2,
  }).format(priceMinor / 100);
  return `${amount} a ${interval}`;
}

/** Limits a user can see on the page; real-money trading stays out until Phase 7. */
const SHOWN_FEATURES = FEATURE_LIMITS.filter((f) => f !== 'realIntegrations');

export interface UsageRow {
  key: CountLimit;
  label: string;
  used: number;
  allowed: number;
  /** At or past the limit, as after a downgrade. */
  full: boolean;
}

export function usageRows(limits: PlanLimits, usage: Record<CountLimit, number>): UsageRow[] {
  return COUNT_LIMITS.filter((k) => k !== 'concurrentBacktests').map((key) => ({
    key,
    label: LIMIT_LABELS[key],
    used: usage[key],
    allowed: limits[key],
    full: usage[key] >= limits[key],
  }));
}

export function limitValue(limits: PlanLimits, key: keyof PlanLimits): string {
  const v = limits[key];
  if (typeof v === 'boolean') return v ? 'Included' : 'Not included';
  return v.toLocaleString('en-US');
}

/** Rows of the plan comparison, in the order they are shown. */
export const COMPARED_LIMITS: (keyof PlanLimits)[] = [...COUNT_LIMITS, ...SHOWN_FEATURES];

export interface SubscriptionNoteInput {
  planName: string;
  status: string | null;
  cancelAtPeriodEnd: boolean;
  /** Already formatted for the person. */
  periodEnd: string | null;
  defaultPlanName: string;
}

/** One sentence on where the subscription stands, or null when there is nothing to say. */
export function subscriptionNote(s: SubscriptionNoteInput): { text: string; warn: boolean } | null {
  if (s.status === 'past_due') {
    return {
      text: 'Your last payment failed. Update your card in Manage billing to keep your plan.',
      warn: true,
    };
  }
  if ((s.status === 'active' || s.status === 'trialing') && s.cancelAtPeriodEnd) {
    return {
      text: `Your ${s.planName} plan ends${s.periodEnd ? ` on ${s.periodEnd}` : ''}, and you move to ${s.defaultPlanName} then.`,
      warn: false,
    };
  }
  if (s.status === 'active' || s.status === 'trialing') {
    return {
      text: s.periodEnd
        ? `Your ${s.planName} plan renews on ${s.periodEnd}.`
        : `Your ${s.planName} plan is active.`,
      warn: false,
    };
  }
  return null;
}
