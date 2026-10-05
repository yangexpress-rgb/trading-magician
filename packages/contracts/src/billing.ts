import type { CountLimit, PlanLimits } from '@tm/domain';
import { z } from 'zod';

/** A plan people can choose (§4.3; ADR 0022). Prices are in minor units (cents). */
export interface PlanDto {
  code: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: string;
  limits: PlanLimits;
  /** The plan new workspaces start on, and the one a cancelled subscription returns to. */
  isDefault: boolean;
}

export interface PlanListDto {
  plans: PlanDto[];
}

/** The signed-in user's plan, their resolved limits and what they use now. */
export interface EntitlementDto {
  planCode: string;
  planName: string;
  limits: PlanLimits;
  usage: Record<CountLimit, number>;
}

/** `details` of a `plan_limit` error. */
export interface PlanLimitDetailsDto {
  limit: keyof PlanLimits;
  planCode: string;
  planName: string;
  allowed: number | boolean;
  used?: number;
}

export const SUBSCRIPTION_STATUS_VALUES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type SubscriptionStatusDto = (typeof SUBSCRIPTION_STATUS_VALUES)[number];

/** `GET /subscription` (§14). Card details stay with the billing provider. */
export interface SubscriptionDto {
  planCode: string;
  planName: string;
  status: SubscriptionStatusDto | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Whether there is a customer record to manage in the provider's portal. */
  canManage: boolean;
  /** Whether checkout is set up on this server. */
  billingAvailable: boolean;
}

export const checkoutSessionRequest = z
  .object({ planCode: z.string().regex(/^[a-z0-9_-]{1,40}$/) })
  .strict();
export type CheckoutSessionRequest = z.input<typeof checkoutSessionRequest>;

/** A page on the billing provider's site to send the browser to. */
export interface BillingRedirectDto {
  url: string;
}
