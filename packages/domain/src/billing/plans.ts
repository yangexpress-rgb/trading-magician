import { z } from 'zod';

/**
 * Plan limits (Design v1.0 §4.3; ADR 0022). Plans are data kept in the
 * database, so a limit changes without a release. A user's limits are their
 * plan's, with any per-user overrides on top. Anything missing or malformed
 * falls back to the most restrictive value, never to "unlimited".
 */

export const COUNT_LIMITS = [
  'savedStrategies',
  'activeStrategies',
  'backtestRunsPerDay',
  'concurrentBacktests',
  'connectedAccounts',
] as const;
export type CountLimit = (typeof COUNT_LIMITS)[number];

export const FEATURE_LIMITS = ['paperIntegrations', 'liveData', 'realIntegrations'] as const;
export type FeatureLimit = (typeof FEATURE_LIMITS)[number];

export type PlanLimits = Record<CountLimit, number> & Record<FeatureLimit, boolean>;

/** What a user gets when nothing else is known: one of everything, no integrations. */
export const FALLBACK_LIMITS: PlanLimits = {
  savedStrategies: 1,
  activeStrategies: 0,
  backtestRunsPerDay: 1,
  concurrentBacktests: 1,
  connectedAccounts: 1,
  paperIntegrations: false,
  liveData: false,
  realIntegrations: false,
};

const count = z.number().int().min(0).max(1_000_000);

function pick(raw: unknown): Partial<PlanLimits> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Partial<PlanLimits> = {};
  const r = raw as Record<string, unknown>;
  for (const k of COUNT_LIMITS) {
    if (count.safeParse(r[k]).success) out[k] = r[k] as number;
  }
  for (const k of FEATURE_LIMITS) {
    if (typeof r[k] === 'boolean') out[k] = r[k];
  }
  return out;
}

export function resolveLimits(planLimits: unknown, overrides?: unknown): PlanLimits {
  return { ...FALLBACK_LIMITS, ...pick(planLimits), ...pick(overrides) };
}

/** Real-money trading stays off in every plan until Phase 7 (ADR 0002). */
export function assertPaperOnlyLimits(limits: PlanLimits): void {
  if (limits.realIntegrations) {
    throw new Error('Real-money integrations cannot be enabled before Phase 7');
  }
}

export const LIMIT_LABELS: Record<CountLimit | FeatureLimit, string> = {
  savedStrategies: 'Saved strategies',
  activeStrategies: 'Active strategies',
  backtestRunsPerDay: 'Back tests per day',
  concurrentBacktests: 'Back tests at a time',
  connectedAccounts: 'Active trading accounts',
  paperIntegrations: 'Alpaca and other paper brokers',
  liveData: 'Market data from a provider',
  realIntegrations: 'Real-money trading',
};
