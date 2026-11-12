import type { CustomRestConfig } from '@tm/domain';
import { z } from 'zod';

/**
 * Settings integrations (§9.2–9.3, §14.4). Credential values travel only in
 * the body of a create or rotate request; no response ever carries them.
 */

const secretValue = z.string().trim().min(1).max(500);

export const createCredentialRequest = z.object({
  provider: z.string().min(1).max(40),
  label: z.string().trim().min(1).max(100),
  fields: z.record(z.string().max(40), secretValue),
});
export type CreateCredentialRequest = z.infer<typeof createCredentialRequest>;

export const rotateCredentialRequest = z.object({
  fields: z.record(z.string().max(40), secretValue),
});
export type RotateCredentialRequest = z.infer<typeof rotateCredentialRequest>;

export const renameCredentialRequest = z.object({
  label: z.string().trim().min(1).max(100),
});
export type RenameCredentialRequest = z.infer<typeof renameCredentialRequest>;

export interface CredentialDto {
  id: string;
  provider: string;
  label: string;
  environment: 'paper';
  /** Field name to masked tail, e.g. { keyId: '••••7Q2A' }. */
  hint: Record<string, string>;
  createdAt: string;
  rotatedAt: string | null;
  usedBy: { kind: 'data_feed' | 'broker'; id: string; name: string }[];
}

export interface CredentialListDto {
  credentials: CredentialDto[];
  /** False until the server has a key to seal new credentials with. */
  storageReady: boolean;
}

// ---------------------------------------------------------------------------
// Data feeds and routes (§9.2, §14.4)
// ---------------------------------------------------------------------------

const assetClassList = z.array(z.string().min(1).max(20)).min(1).max(10);

/**
 * A custom REST feed's description (ADR 0041). Checked in full on the server
 * (`checkCustomRestConfig`); here only its size is bounded.
 */
const customConfig = z
  .record(z.string().max(40), z.unknown())
  .refine((v) => JSON.stringify(v).length <= 8_000, 'The feed settings are too long');

export const createFeedRequest = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.string().min(1).max(40),
  credentialId: z.uuid().nullable().optional(),
  assetClasses: assetClassList,
  config: customConfig.optional(),
  /** A succeeded test of this config and key; a custom feed cannot be saved without one. */
  testId: z.uuid().nullable().optional(),
});
export type CreateFeedRequest = z.infer<typeof createFeedRequest>;

export const updateFeedRequest = z.object({
  rowVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  credentialId: z.uuid().nullable().optional(),
  assetClasses: assetClassList.optional(),
  config: customConfig.optional(),
  testId: z.uuid().nullable().optional(),
});
export type UpdateFeedRequest = z.infer<typeof updateFeedRequest>;

/** "Test" on a custom REST feed before it is saved (ADR 0041). */
export const customFeedTestRequest = z.object({
  config: customConfig,
  credentialId: z.uuid().nullable().optional(),
  symbol: z.string().trim().min(1).max(12).optional(),
});
export type CustomFeedTestRequest = z.infer<typeof customFeedTestRequest>;

export interface CustomFeedTestDto {
  id: string;
  status: 'pending' | 'succeeded' | 'failed';
  symbol: string;
  result: {
    symbol: string;
    bars: {
      count: number;
      first: string | null;
      last: string | null;
      sample: {
        date: string;
        open: string;
        high: string;
        low: string;
        close: string;
        volume: string;
      }[];
      url: string;
    };
    quote: { last: string; bid: string | null; ask: string | null; at: string | null; url: string };
  } | null;
  message: string | null;
  createdAt: string;
}

export const setFeedActiveRequest = z.object({
  active: z.boolean(),
  replacementFeedId: z.uuid().optional(),
  pauseStrategies: z.boolean().optional(),
});
export type SetFeedActiveRequest = z.infer<typeof setFeedActiveRequest>;

export const ROUTE_DATA_TYPES = ['quotes', 'trades', 'bars'] as const;

export const createRouteRequest = z.object({
  assetClass: z.string().min(1).max(20),
  venue: z.string().trim().min(1).max(20).nullable(),
  dataType: z.enum(ROUTE_DATA_TYPES),
  primaryFeedId: z.uuid(),
  fallbackFeedId: z.uuid().nullable(),
});
export type CreateRouteRequest = z.infer<typeof createRouteRequest>;

export const updateRouteRequest = z.object({
  rowVersion: z.number().int().positive(),
  primaryFeedId: z.uuid(),
  fallbackFeedId: z.uuid().nullable(),
});
export type UpdateRouteRequest = z.infer<typeof updateRouteRequest>;

export type ConnectionHealthDto = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface FeedDto {
  id: string;
  name: string;
  provider: string;
  credential: { id: string; label: string } | null;
  assetClasses: string[];
  isRealtime: boolean;
  isActive: boolean;
  health: ConnectionHealthDto;
  entitlement: 'unknown' | 'entitled' | 'not_entitled';
  lastSuccessAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  checking: boolean;
  routes: {
    routeId: string;
    role: 'primary' | 'fallback';
    assetClass: string;
    venue: string | null;
    dataType: (typeof ROUTE_DATA_TYPES)[number];
    serving: boolean;
  }[];
  /** A custom REST feed's description (`CustomRestConfig`); null for other providers. */
  config: CustomRestConfig | null;
  rowVersion: number;
}

export interface RouteDto {
  id: string;
  assetClass: string;
  venue: string | null;
  dataType: (typeof ROUTE_DATA_TYPES)[number];
  primary: { id: string; name: string; isActive: boolean };
  fallback: { id: string; name: string; isActive: boolean } | null;
  activeSource: 'primary' | 'fallback';
  switchedAt: string | null;
  rowVersion: number;
}

export interface FeedListDto {
  feeds: FeedDto[];
  routes: RouteDto[];
  /**
   * The admin's feeds this person uses because they have none of that kind
   * (N237, ADR 0084): names and providers only.
   */
  shared: SharedFeedDto[];
  /** For an admin: whether their feeds are shared with members; null for everyone else. */
  sharing: boolean | null;
}

export interface SharedFeedDto {
  name: string;
  provider: string;
  kind: 'prices' | 'company' | 'options';
}

export const setFeedSharingRequest = z.object({ on: z.boolean() });
export type SetFeedSharingRequest = z.infer<typeof setFeedSharingRequest>;

/** `details` of the invalid_state error when a feed in use is turned off. */
export interface FeedInUseDetails {
  dependents: { runtimeId: string; strategyId: string; strategyName: string; status: string }[];
}

// ---------------------------------------------------------------------------
// Instrument lookups (ADR 0017)

export const createInstrumentLookupRequest = z.object({
  /** A ticker, or a company name to search for (ADR 0029). */
  symbol: z.string().trim().min(1).max(60),
});
export type CreateInstrumentLookupRequest = z.infer<typeof createInstrumentLookupRequest>;

export interface InstrumentOptionDto {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
  /** `indicator_only` for an index such as the VIX: watched, never traded (v1.2 item 5). */
  kind?: 'tradable' | 'indicator_only' | undefined;
}

export interface InstrumentLookupDto {
  id: string;
  symbol: string;
  status: 'pending' | 'found' | 'not_found' | 'failed';
  /** Why nothing was found, in words for the person. */
  message: string | null;
  instrument: InstrumentOptionDto | null;
  /** When nothing trades as what was typed: the closest listings, to pick from. */
  candidates: Omit<InstrumentOptionDto, 'id'>[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Trading platforms and accounts (§9.3, §14.4; ADR 0018)

export const createPlatformRequest = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.string().min(1).max(40),
  credentialId: z.uuid(),
});
export type CreatePlatformRequest = z.infer<typeof createPlatformRequest>;

export const updatePlatformRequest = z.object({
  rowVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  credentialId: z.uuid().optional(),
});
export type UpdatePlatformRequest = z.infer<typeof updatePlatformRequest>;

export const setPlatformActiveRequest = z.object({
  active: z.boolean(),
  /** Turning off a platform running strategies trade through pauses them (§9.4). */
  pauseStrategies: z.boolean().optional(),
});
export type SetPlatformActiveRequest = z.infer<typeof setPlatformActiveRequest>;

export const updateAccountRequest = z.object({
  rowVersion: z.number().int().positive(),
  nickname: z.string().trim().min(1).max(100).optional(),
  makeDefault: z.literal(true).optional(),
  /** With makeDefault: also move strategies from the old default (§9.4). */
  migrateStrategies: z.boolean().optional(),
  active: z.boolean().optional(),
  pauseStrategies: z.boolean().optional(),
});
export type UpdateAccountRequest = z.infer<typeof updateAccountRequest>;

export interface AccountCapabilitiesDto {
  assetClasses: readonly string[];
  orderTypes: readonly string[];
  timeInForce: readonly string[];
  sides: readonly string[];
  extendedHours: boolean;
  shortSelling: boolean;
  fractionalQuantity: boolean;
  atomicMultiLeg: boolean;
  coverage?: 'demo' | 'us' | undefined;
}

export interface AccountDto {
  id: string;
  platformId: string;
  nickname: string;
  maskedExternalId: string;
  mode: 'paper';
  currency: string;
  capabilities: AccountCapabilitiesDto;
  isDefault: boolean;
  isActive: boolean;
  lastSyncedAt: string | null;
  usedBy: { strategyId: string; strategyName: string; status: 'running' | 'paused' }[];
  rowVersion: number;
}

export interface PlatformDto {
  id: string;
  name: string;
  provider: string;
  environment: 'paper';
  credential: { id: string; label: string } | null;
  isActive: boolean;
  health: ConnectionHealthDto;
  lastCheckedAt: string | null;
  lastError: string | null;
  /** A connect or test is waiting for the worker. */
  checking: boolean;
  accounts: AccountDto[];
  rowVersion: number;
}

export interface PlatformListDto {
  platforms: PlatformDto[];
}

export interface AccountUpdateDto {
  account: AccountDto;
  migrated: number;
  skipped: number;
}

/** `details` of the invalid_state error when something running strategies use is turned off. */
export interface AccountInUseDetails {
  dependents: { runtimeId: string; strategyId: string; strategyName: string; status: string }[];
}
