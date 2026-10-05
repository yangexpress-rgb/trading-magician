import { resolveLimits, type CountLimit, type FeatureLimit, type PlanLimits } from '@tm/domain';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import { backtestRuns, entitlements, plans, strategies, tradingAccounts } from './schema';

/**
 * Plan limits, enforced on the server (Design v1.0 §4.3, §19.8; ADR 0022).
 * A user's limits are their plan's, resolved at read time so a change to the
 * plan catalog applies at once, with any per-user overrides on top.
 */

export interface PlanLimitDetails {
  limit: CountLimit | FeatureLimit;
  planCode: string;
  planName: string;
  allowed: number | boolean;
  used?: number;
}

export class PlanLimitError extends Error {
  readonly code = 'plan_limit' as const;
  constructor(
    message: string,
    public readonly details: PlanLimitDetails,
  ) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

export interface Entitlement {
  planCode: string;
  planName: string;
  limits: PlanLimits;
}

export async function loadEntitlement(tx: Transaction): Promise<Entitlement> {
  const [row] = await tx
    .select({
      planCode: entitlements.planCode,
      overrides: entitlements.overrides,
      planName: plans.name,
      planLimits: plans.limits,
    })
    .from(entitlements)
    .innerJoin(plans, eq(plans.code, entitlements.planCode));
  // No entitlement means no workspace yet; the most restrictive limits apply.
  if (!row) return { planCode: 'none', planName: 'No', limits: resolveLimits(undefined) };
  return {
    planCode: row.planCode,
    planName: row.planName,
    limits: resolveLimits(row.planLimits, row.overrides),
  };
}

export type PlanUsage = Record<CountLimit, number>;

export async function loadUsage(tx: Transaction): Promise<PlanUsage> {
  const [s] = await tx
    .select({
      saved: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${strategies.status} = 'actively_executing')::int`,
    })
    .from(strategies)
    .where(isNull(strategies.deletedAt));
  const [b] = await tx
    .select({
      running: sql<number>`count(*) filter (where ${backtestRuns.status} in ('queued', 'running'))::int`,
      today: sql<number>`count(*) filter (where ${backtestRuns.createdAt} > now() - interval '1 day')::int`,
    })
    .from(backtestRuns);
  const [a] = await tx
    .select({ active: sql<number>`count(*)::int` })
    .from(tradingAccounts)
    .where(eq(tradingAccounts.isActive, true));
  return {
    savedStrategies: s?.saved ?? 0,
    activeStrategies: s?.active ?? 0,
    backtestRunsPerDay: b?.today ?? 0,
    concurrentBacktests: b?.running ?? 0,
    connectedAccounts: a?.active ?? 0,
  };
}

const UPGRADE = 'See Settings › Subscription and billing to upgrade.';

const COUNT_MESSAGES: Record<CountLimit, (plan: string, n: number) => string> = {
  savedStrategies: (plan, n) =>
    `The ${plan} plan keeps up to ${n} ${n === 1 ? 'strategy' : 'strategies'}. Delete one, or upgrade. ${UPGRADE}`,
  activeStrategies: (plan, n) =>
    n === 0
      ? `The ${plan} plan can't run strategies. ${UPGRADE}`
      : `The ${plan} plan runs ${n} ${n === 1 ? 'strategy' : 'strategies'} at a time. Stop one first, or upgrade. ${UPGRADE}`,
  backtestRunsPerDay: (plan, n) =>
    `The ${plan} plan allows ${n} back tests a day. Try again tomorrow, or upgrade. ${UPGRADE}`,
  concurrentBacktests: (_plan, n) =>
    `You can run ${n} ${n === 1 ? 'back test' : 'back tests'} at a time. Wait for one to finish or cancel it.`,
  connectedAccounts: (plan, n) =>
    `The ${plan} plan allows ${n} active trading ${n === 1 ? 'account' : 'accounts'}. Turn one off first, or upgrade. ${UPGRADE}`,
};

const FEATURE_MESSAGES: Record<FeatureLimit, (plan: string) => string> = {
  paperIntegrations: (plan) =>
    `The ${plan} plan trades on the demo account only. Connecting Alpaca or another broker needs a plan that includes it. ${UPGRADE}`,
  liveData: (plan) =>
    `The ${plan} plan uses the demo feed only. Adding a market data provider needs a plan that includes it. ${UPGRADE}`,
  realIntegrations: () => 'Real-money trading is not available yet.',
};

/**
 * Throws unless the user can add `adding` more of `limit`. Takes a per-user
 * lock first, so two requests at once can't both squeeze past the limit.
 */
export async function assertWithinLimit(
  tx: Transaction,
  userId: string,
  limit: CountLimit,
  adding = 1,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('plan-limit:' || ${userId}))`);
  const { planCode, planName, limits } = await loadEntitlement(tx);
  const used = (await loadUsage(tx))[limit];
  const allowed = limits[limit];
  if (used + adding > allowed) {
    throw new PlanLimitError(COUNT_MESSAGES[limit](planName, allowed), {
      limit,
      planCode,
      planName,
      allowed,
      used,
    });
  }
}

export async function assertFeature(tx: Transaction, feature: FeatureLimit): Promise<void> {
  const { planCode, planName, limits } = await loadEntitlement(tx);
  if (!limits[feature]) {
    throw new PlanLimitError(FEATURE_MESSAGES[feature](planName), {
      limit: feature,
      planCode,
      planName,
      allowed: false,
    });
  }
}

/** Whether one more of `limit` fits, without throwing; for work the worker does on its own. */
export async function hasRoomFor(tx: Transaction, limit: CountLimit): Promise<boolean> {
  const { limits } = await loadEntitlement(tx);
  return (await loadUsage(tx))[limit] < limits[limit];
}

export interface PlanSummary {
  code: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: string;
  limits: PlanLimits;
}

/** The plans people can choose, cheapest first. */
export async function listOfferedPlans(tx: Transaction): Promise<PlanSummary[]> {
  const rows = await tx
    .select()
    .from(plans)
    .where(eq(plans.offered, true))
    .orderBy(asc(plans.sortOrder), asc(plans.priceMinor));
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    description: r.description,
    priceMinor: r.priceMinor,
    currency: r.currency,
    interval: r.interval,
    limits: resolveLimits(r.limits),
  }));
}

/** The plan a new workspace starts on: `requested` if it exists, else the catalog's default. */
export async function startingPlanCode(
  tx: Transaction,
  requested?: string | undefined,
): Promise<string> {
  if (requested) {
    const [row] = await tx
      .select({ code: plans.code })
      .from(plans)
      .where(eq(plans.code, requested));
    if (row) return row.code;
  }
  const [row] = await tx.select({ code: plans.code }).from(plans).where(eq(plans.isDefault, true));
  if (!row) throw new Error('The plan catalog has no default plan');
  return row.code;
}
