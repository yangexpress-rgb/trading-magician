import {
  STRATEGY_STATUSES,
  type StrategyDefinition,
  type StrategyStatus,
  type ValidationResult,
} from '@tm/domain';
import { z } from 'zod';

/**
 * Request and response shapes for /api/v1/strategies (Design v1.0 §14.1).
 * Requests are validated with these schemas on the server; responses are
 * plain JSON, so dates travel as ISO strings and decimals as strings.
 */

const name = z
  .string()
  .trim()
  .min(1, 'Give the strategy a name')
  .max(120, 'Use 120 characters or fewer');
const description = z.string().trim().max(2000, 'Use 2,000 characters or fewer');
const tags = z
  .array(z.string().trim().min(1).max(32, 'Tags are 32 characters at most'))
  .max(20, 'Use up to 20 tags')
  .transform((t) => [...new Set(t)]);
const rowVersion = z.number().int().positive();

/**
 * The builder's Library entry picker (ADR 0054): link an existing entry, whose
 * number the strategy then shows, or start a new record of its own.
 */
export const libraryChoice = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('entry'),
    registrationNumber: z.string().trim().toUpperCase().min(5).max(16),
  }),
  z.object({ kind: z.literal('new') }),
]);
export type LibraryChoiceRequest = z.input<typeof libraryChoice>;

/** A strategy's Library record as the API returns it; null until the first save with instruments. */
export interface StrategyLibraryDto {
  entryId: string;
  registrationNumber: string;
  name: string;
  status: 'registered' | 'retired';
  autoCreated: boolean;
}

export const STRATEGY_SORTS = [
  'updated',
  'created',
  'name',
  'status',
  'number',
  'theory',
  'assets',
  'version',
  'account',
  'backtest',
] as const;
export const ARCHIVE_FILTERS = ['exclude', 'include', 'only'] as const;

/** Query string for GET /strategies. Repeated `status` params filter by several statuses. */
export const listStrategiesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z
    .union([z.enum(STRATEGY_STATUSES), z.array(z.enum(STRATEGY_STATUSES))])
    .transform((s) => (Array.isArray(s) ? s : [s]))
    .optional(),
  instrumentId: z.uuid().optional(),
  updatedFrom: z.iso.date().optional(),
  updatedTo: z.iso.date().optional(),
  archived: z.enum(ARCHIVE_FILTERS).default('exclude'),
  /** `shared=1`: only copies shared with you (ADR 0056). */
  shared: z
    .enum(['1', 'true'])
    .transform(() => true)
    .optional(),
  /** By strategy number, ascending, unless asked otherwise (N186). */
  sort: z.enum(STRATEGY_SORTS).default('number'),
  direction: z.enum(['asc', 'desc']).default('asc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListStrategiesQuery = z.input<typeof listStrategiesQuery>;

export const createStrategyRequest = z.object({
  name,
  description: description.optional(),
  tags: tags.optional(),
  /** Omit to start from an empty definition with the confirmed defaults. */
  definition: z.unknown().optional(),
  /** Omit for a new Library record (created once the strategy has instruments). */
  library: libraryChoice.optional(),
});
export type CreateStrategyRequest = z.input<typeof createStrategyRequest>;

export const updateStrategyRequest = z
  .object({
    rowVersion,
    name: name.optional(),
    description: description.optional(),
    tags: tags.optional(),
    definition: z.unknown().optional(),
    archived: z.boolean().optional(),
    status: z.enum(['created', 'under_testing']).optional(),
    library: libraryChoice.optional(),
  })
  .strict();
export type UpdateStrategyRequest = z.input<typeof updateStrategyRequest>;

export const rowVersionRequest = z.object({ rowVersion }).strict();
export const duplicateStrategyRequest = z
  .object({ name: name.optional(), description: description.optional() })
  .strict();

export const startStrategyRequest = z
  .object({
    rowVersion,
    /** Paper only in this build; the field makes the mode explicit in every start. */
    mode: z.literal('paper'),
    confirmed: z.literal(true, { error: 'Confirm to start this strategy' }),
    acknowledgedWarnings: z.array(z.string().max(64)).max(50).default([]),
  })
  .strict();
export type StartStrategyRequest = z.input<typeof startStrategyRequest>;

/** Stopping ends new orders only; cancelling and closing are separate, explicit choices (§8.1). */
export const stopStrategyRequest = z
  .object({
    rowVersion,
    reason: z.string().trim().max(500).optional(),
    cancelOpenOrders: z.boolean().default(false),
    closePositions: z.boolean().default(false),
  })
  .strict();
export type StopStrategyRequest = z.input<typeof stopStrategyRequest>;

// ---------------------------------------------------------------------------
// Responses

export interface StrategySummaryDto {
  id: string;
  name: string;
  /** The strategy's own Strategy Lab number (ADR 0065), e.g. S00032-SD. */
  labNumber: string | null;
  /** The number of the theory it builds (ADR 0054). */
  libraryNumber: string | null;
  /** The theory it was built from; null when its theory was auto-created from it (N185). */
  theoryNumber: string | null;
  description: string;
  tags: string[];
  status: StrategyStatus;
  hasBeenActive: boolean;
  currentVersionNo: number | null;
  accountMode: 'paper' | 'live' | null;
  instruments: { id: string; symbol: string }[];
  latestBacktest: {
    runId: string;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
    netReturnPct: string | null;
    finishedAt: string | null;
  } | null;
  /** A copy received by sharing (ADR 0056). */
  shared: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

/** "Shared by Yong (U0001)" on a received copy (ADR 0056). */
export interface SharedProvenanceDto {
  shareId: string;
  /** Null once the sender's account is purged. */
  senderName: string | null;
  senderCode: string;
  senderIsAdmin: boolean;
  sourceNumber: string;
  acceptedAt: string | null;
}

export interface StrategyListDto {
  items: StrategySummaryDto[];
  total: number;
}

export interface StrategyVersionSummaryDto {
  id: string;
  versionNo: number;
  definitionHash: string;
  createdAt: string;
}

export interface StrategyDetailDto {
  id: string;
  name: string;
  library: StrategyLibraryDto | null;
  /** Who shared this copy (ADR 0056); null for a strategy made here. */
  sharedBy: SharedProvenanceDto | null;
  description: string;
  tags: string[];
  status: StrategyStatus;
  hasBeenActive: boolean;
  definition: StrategyDefinition;
  definitionHash: string;
  currentVersion: StrategyVersionSummaryDto | null;
  hasUnpublishedChanges: boolean;
  versions: StrategyVersionSummaryDto[];
  statusHistory: {
    fromStatus: StrategyStatus;
    toStatus: StrategyStatus;
    versionNo: number | null;
    reason: string | null;
    acknowledgedWarnings: string[];
    changedAt: string;
  }[];
  baseCurrency: string;
  timezone: string;
  defaultAccountId: string | null;
  dataRouteId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  rowVersion: number;
}

export interface StrategyVersionDto extends StrategyVersionSummaryDto {
  definition: StrategyDefinition;
}

export interface ValidateStrategyDto extends ValidationResult {
  definitionHash: string;
  /** The latest completed back test, shown before Start (§7.4). */
  latestBacktest: { runId: string; definitionHash: string; finishedAt: string } | null;
}

export interface PublishVersionDto {
  strategy: StrategyDetailDto;
  created: boolean;
}
