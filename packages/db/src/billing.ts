import { eq, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { pauseStrategiesOverPlan, type PausedForPlan } from './entitlements';
import { notify } from './notifications';
import { billingEvents, entitlements, plans, subscriptions } from './schema';
import { withTenant } from './tenant';

/**
 * Subscriptions and billing webhooks (Design v1.0 §4.3, §19.8; ADR 0023).
 * The provider is authoritative: after any event the app reads the
 * subscription from the provider and applies that, so events can arrive late,
 * twice or out of order. Each event id is recorded, so a replay changes nothing.
 */

export type SubscriptionStatus = NonNullable<(typeof subscriptions.$inferSelect)['status']>;

/** Statuses that keep the plan paid for without question. */
const PAYING_NOW: readonly SubscriptionStatus[] = ['active', 'trialing'];

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
  graceEndsAt: Date | null;
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
    graceEndsAt: sub?.graceEndsAt ?? null,
    customerId: sub?.customerId ?? null,
    subscriptionId: sub?.subscriptionId ?? null,
  };
}

export interface ApplyResult {
  fromPlan: string;
  toPlan: string;
  changed: boolean;
  /** Strategies paused because the new plan doesn't cover them. */
  paused: PausedForPlan[];
}

/** How long a failed payment keeps the paid plan (Phase 6 decision 3). */
export const GRACE_DAYS = 7;
/** Days into the grace period a reminder is sent; day 0 is the failure itself. */
export const GRACE_REMINDER_DAYS = [3, 6] as const;
const DAY_MS = 24 * 3600_000;

const UNPAID: readonly SubscriptionStatus[] = ['past_due', 'unpaid'];

/**
 * Applies the provider's view of a workspace's subscription (ADR 0023, 0024):
 * stores it and moves the entitlement to the plan it pays for. A failed
 * payment keeps that plan for a grace period; after it, or once the
 * subscription ends, the workspace returns to the default plan and running
 * strategies the plan no longer covers are paused. Every change is audited and
 * the person is told, so nothing about trading changes silently.
 */
export async function applySubscription(
  tx: Transaction,
  input: {
    userId: string;
    state: SubscriptionState;
    prices: readonly PlanPrice[];
    reason: string;
    now?: Date | undefined;
  },
): Promise<ApplyResult> {
  const { userId, state } = input;
  const now = input.now ?? new Date();
  const paid = input.prices.find((p) => p.priceId !== null && p.priceId === state.priceId);
  const [defaultPlan] = await tx
    .select({ code: plans.code, name: plans.name })
    .from(plans)
    .where(eq(plans.isDefault, true));
  if (!defaultPlan) throw new Error('The plan catalog has no default plan');
  const [existing] = await tx.select().from(subscriptions);

  // The grace period starts with the first failed payment of this subscription.
  const sameSubscription = existing?.subscriptionId === state.subscriptionId;
  const graceEndsAt = UNPAID.includes(state.status)
    ? ((sameSubscription ? existing?.graceEndsAt : null) ??
      new Date(now.getTime() + GRACE_DAYS * DAY_MS))
    : null;
  const graceStarted = graceEndsAt !== null && !(sameSubscription && existing?.graceEndsAt);
  const inGrace = graceEndsAt !== null && now < graceEndsAt;
  const entitled =
    paid && (PAYING_NOW.includes(state.status) || inGrace) ? paid.code : defaultPlan.code;

  const [before] = await tx.execute<{
    previous_plan: string;
    previous_status: string | null;
    applied: boolean;
  }>(
    sql`select * from apply_subscription(${userId}::uuid, ${state.customerId}, ${state.subscriptionId},
      ${state.status}::subscription_status, ${state.priceId}, ${paid?.code ?? null},
      ${state.currentPeriodEnd?.toISOString() ?? null}::timestamptz, ${state.cancelAtPeriodEnd}, ${entitled},
      ${graceEndsAt?.toISOString() ?? null}::timestamptz)`,
  );
  const fromPlan = before?.previous_plan ?? entitled;
  // A late event about an older subscription doesn't undo a newer, paying one.
  if (before && !before.applied) return { fromPlan, toPlan: fromPlan, changed: false, paused: [] };
  const changed = fromPlan !== entitled;
  const context = {
    fromPlan,
    toPlan: entitled,
    fromStatus: before?.previous_status ?? null,
    status: state.status,
    graceEndsAt: graceEndsAt?.toISOString() ?? null,
    reason: input.reason,
  };
  if (changed || before?.previous_status !== state.status) {
    await recordAudit(tx, {
      userId,
      actorType: 'system',
      action: changed ? 'subscription.plan_changed' : 'subscription.status_changed',
      resourceType: 'user',
      resourceId: userId,
      context,
    });
  }

  const planName = async (code: string) =>
    input.prices.find((p) => p.code === code)?.name ??
    (await tx.select({ name: plans.name }).from(plans).where(eq(plans.code, code)))[0]?.name ??
    code;
  if (graceStarted && inGrace && paid) {
    await notify(tx, {
      userId,
      kind: 'billing',
      title: 'Your payment failed',
      body: `Update your card in Manage billing by ${graceEndsAt.toISOString().slice(0, 10)} to keep the ${paid.name} plan. After that you move to ${defaultPlan.name}, and strategies beyond its limits pause.`,
      link: '/settings/billing',
      resourceType: 'user',
      resourceId: userId,
      dedupeKey: `grace:${state.subscriptionId}:${graceEndsAt.toISOString()}:0`,
    });
  }

  let paused: PausedForPlan[] = [];
  if (changed) {
    paused = await pauseStrategiesOverPlan(tx, userId, context);
    const toName = await planName(entitled);
    const why =
      entitled !== defaultPlan.code
        ? 'Your subscription is set up.'
        : graceEndsAt
          ? 'Your payment was not made within the grace period.'
          : 'Your subscription has ended.';
    const pausedText =
      paused.length > 0
        ? ` Paused because the plan doesn't cover them: ${paused.map((p) => p.strategyName).join(', ')}. Resume them in Orders when your plan allows.`
        : '';
    await notify(tx, {
      userId,
      kind: 'billing',
      title: `You are now on the ${toName} plan`,
      body: `${why}${pausedText}`,
      link: paused.length > 0 ? '/orders' : '/settings/billing',
      resourceType: 'user',
      resourceId: userId,
      dedupeKey: `plan:${state.subscriptionId}:${entitled}:${state.status}`,
    });
  }
  return { fromPlan, toPlan: entitled, changed, paused };
}

/**
 * The grace period's reminders and end, for each workspace in one (ADR 0024).
 * Run by the worker every minute; repeats are harmless.
 */
export async function runBillingGrace(
  db: Database,
  options: { prices: (tx: Transaction) => Promise<readonly PlanPrice[]>; now?: Date },
): Promise<number> {
  const now = options.now ?? new Date();
  const due = await db.execute<{ due_user: string }>(sql`select * from billing_grace_due(${100})`);
  for (const { due_user: userId } of due) {
    await withTenant(db, { userId }, async (tx) => {
      const [sub] = await tx.select().from(subscriptions);
      if (!sub?.graceEndsAt || !sub.subscriptionId || !sub.status) return;
      if (now >= sub.graceEndsAt) {
        await applySubscription(tx, {
          userId,
          state: {
            customerId: sub.customerId,
            subscriptionId: sub.subscriptionId,
            status: sub.status,
            priceId: sub.priceId,
            currentPeriodEnd: sub.currentPeriodEnd,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          },
          prices: await options.prices(tx),
          reason: 'grace_period_ended',
          now,
        });
        return;
      }
      const started = sub.graceEndsAt.getTime() - GRACE_DAYS * DAY_MS;
      const day = Math.floor((now.getTime() - started) / DAY_MS);
      const reminder = [...GRACE_REMINDER_DAYS].reverse().find((d) => day >= d);
      if (reminder === undefined) return;
      const left = Math.ceil((sub.graceEndsAt.getTime() - now.getTime()) / DAY_MS);
      await notify(tx, {
        userId,
        kind: 'billing',
        title: `Your payment is still due: ${left} ${left === 1 ? 'day' : 'days'} left`,
        body: `Update your card in Manage billing by ${sub.graceEndsAt.toISOString().slice(0, 10)} to keep your plan. After that, strategies beyond the free plan's limits pause.`,
        link: '/settings/billing',
        resourceType: 'user',
        resourceId: userId,
        dedupeKey: `grace:${sub.subscriptionId}:${sub.graceEndsAt.toISOString()}:${reminder}`,
      });
    });
  }
  return due.length;
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
