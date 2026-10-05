import { eq, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { notify } from './notifications';
import { billingEvents, entitlements, plans, subscriptions } from './schema';

/**
 * Subscriptions and billing webhooks (Design v1.0 §4.3, §19.8; ADR 0023).
 * The provider is authoritative: after any event the app reads the
 * subscription from the provider and applies that, so events can arrive late,
 * twice or out of order. Each event id is recorded, so a replay changes nothing.
 */

export type SubscriptionStatus = NonNullable<(typeof subscriptions.$inferSelect)['status']>;

/** Statuses that keep the plan paid for. */
const PAYING: readonly SubscriptionStatus[] = ['active', 'trialing', 'past_due'];

export interface SubscriptionState {
  customerId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export class BillingError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'invalid_state' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

/** The workspace a provider's customer or subscription belongs to, across tenants. */
export async function billingUserFor(
  db: Database,
  ids: { customerId: string | null; subscriptionId: string | null },
): Promise<string | null> {
  const [row] = await db.execute<{ user_id: string | null }>(
    sql`select billing_user_for(${ids.customerId}, ${ids.subscriptionId}) as user_id`,
  );
  return row?.user_id ?? null;
}

/** Records an event id; false if it was seen before (§19.8). */
export async function recordBillingEvent(
  tx: Transaction,
  event: { id: string; type: string; userId: string | null },
): Promise<boolean> {
  const rows = await tx
    .insert(billingEvents)
    .values({ id: event.id, type: event.type, userId: event.userId })
    .onConflictDoNothing()
    .returning({ id: billingEvents.id });
  return rows.length > 0;
}

export interface PlanPrice {
  code: string;
  name: string;
  priceId: string | null;
}

/** Offered plans with their provider price. `fakePrices` stands in for Stripe in tests. */
export async function planPrices(tx: Transaction, fakePrices = false): Promise<PlanPrice[]> {
  const rows = await tx
    .select({ code: plans.code, name: plans.name, stripePriceId: plans.stripePriceId })
    .from(plans);
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    priceId: fakePrices ? `price_fake_${r.code}` : r.stripePriceId,
  }));
}

export interface SubscriptionSummary {
  planCode: string;
  planName: string;
  status: SubscriptionStatus | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  customerId: string | null;
  subscriptionId: string | null;
}

export async function getSubscription(tx: Transaction): Promise<SubscriptionSummary> {
  const [ent] = await tx
    .select({ planCode: entitlements.planCode, planName: plans.name })
    .from(entitlements)
    .innerJoin(plans, eq(plans.code, entitlements.planCode));
  const [sub] = await tx.select().from(subscriptions);
  return {
    planCode: ent?.planCode ?? 'none',
    planName: ent?.planName ?? 'No',
    status: sub?.status ?? null,
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    customerId: sub?.customerId ?? null,
    subscriptionId: sub?.subscriptionId ?? null,
  };
}

export interface ApplyResult {
  fromPlan: string;
  toPlan: string;
  changed: boolean;
}

/**
 * Applies the provider's view of a workspace's subscription: stores it and
 * moves the entitlement to the plan it pays for, or to the default plan once
 * it no longer pays. Audited, and the person is told when their plan changes.
 */
export async function applySubscription(
  tx: Transaction,
  input: {
    userId: string;
    state: SubscriptionState;
    prices: readonly PlanPrice[];
    reason: string;
  },
): Promise<ApplyResult> {
  const { userId, state } = input;
  const paid = input.prices.find((p) => p.priceId !== null && p.priceId === state.priceId);
  const [defaultPlan] = await tx
    .select({ code: plans.code })
    .from(plans)
    .where(eq(plans.isDefault, true));
  if (!defaultPlan) throw new Error('The plan catalog has no default plan');
  const entitled = PAYING.includes(state.status) && paid ? paid.code : defaultPlan.code;

  const [before] = await tx.execute<{
    previous_plan: string;
    previous_status: string | null;
    applied: boolean;
  }>(
    sql`select * from apply_subscription(${userId}::uuid, ${state.customerId}, ${state.subscriptionId},
      ${state.status}::subscription_status, ${state.priceId}, ${paid?.code ?? null},
      ${state.currentPeriodEnd?.toISOString() ?? null}::timestamptz, ${state.cancelAtPeriodEnd}, ${entitled})`,
  );
  const fromPlan = before?.previous_plan ?? entitled;
  // A late event about an older subscription doesn't undo a newer, paying one.
  if (before && !before.applied) return { fromPlan, toPlan: fromPlan, changed: false };
  const changed = fromPlan !== entitled;
  if (changed || before?.previous_status !== state.status) {
    await recordAudit(tx, {
      userId,
      actorType: 'system',
      action: changed ? 'subscription.plan_changed' : 'subscription.status_changed',
      resourceType: 'user',
      resourceId: userId,
      context: {
        fromPlan,
        toPlan: entitled,
        fromStatus: before?.previous_status ?? null,
        status: state.status,
        reason: input.reason,
      },
    });
  }
  if (changed) {
    const toName =
      input.prices.find((p) => p.code === entitled)?.name ??
      (await tx.select({ name: plans.name }).from(plans).where(eq(plans.code, entitled)))[0]
        ?.name ??
      entitled;
    await notify(tx, {
      userId,
      kind: 'billing',
      title: `You are now on the ${toName} plan`,
      body:
        entitled === defaultPlan.code && paid
          ? 'Your subscription has ended.'
          : 'Your subscription is set up.',
      link: '/settings/billing',
      resourceType: 'user',
      resourceId: userId,
      dedupeKey: `plan:${state.subscriptionId}:${entitled}:${state.status}`,
    });
  }
  return { fromPlan, toPlan: entitled, changed };
}

/** Subscriptions due a check against the provider, in case a webhook was missed. */
export async function claimSubscriptionSyncs(
  db: Database,
  options: { leaseSeconds: number; everySeconds: number; limit: number },
): Promise<{ userId: string; subscriptionId: string }[]> {
  const rows = await db.execute<{ claimed_user: string; claimed_subscription: string }>(
    sql`select * from claim_subscription_syncs(${options.leaseSeconds}, ${options.everySeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ userId: r.claimed_user, subscriptionId: r.claimed_subscription }));
}
