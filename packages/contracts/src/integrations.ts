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

export const createFeedRequest = z.object({
  name: z.string().trim().min(1).max(100),
  provider: z.string().min(1).max(40),
  credentialId: z.uuid().nullable().optional(),
  assetClasses: assetClassList,
});
export type CreateFeedRequest = z.infer<typeof createFeedRequest>;

export const updateFeedRequest = z.object({
  rowVersion: z.number().int().positive(),
  name: z.string().trim().min(1).max(100).optional(),
  credentialId: z.uuid().nullable().optional(),
  assetClasses: assetClassList.optional(),
});
export type UpdateFeedRequest = z.infer<typeof updateFeedRequest>;

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
}

/** `details` of the invalid_state error when a feed in use is turned off. */
export interface FeedInUseDetails {
  dependents: { runtimeId: string; strategyId: string; strategyName: string; status: string }[];
}

// ---------------------------------------------------------------------------
// Instrument lookups (ADR 0017)

export const createInstrumentLookupRequest = z.object({
  symbol: z.string().trim().min(1).max(12),
});
export type CreateInstrumentLookupRequest = z.infer<typeof createInstrumentLookupRequest>;

export interface InstrumentOptionDto {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
}

export interface InstrumentLookupDto {
  id: string;
  symbol: string;
  status: 'pending' | 'found' | 'not_found' | 'failed';
  /** Why nothing was found, in words for the person. */
  message: string | null;
  instrument: InstrumentOptionDto | null;
  createdAt: string;
}
