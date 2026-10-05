import type { CountLimit, PlanLimits } from '@tm/domain';

/** A plan people can choose (§4.3; ADR 0022). Prices are in minor units (cents). */
export interface PlanDto {
  code: string;
  name: string;
  description: string;
  priceMinor: number;
  currency: string;
  interval: string;
  limits: PlanLimits;
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
