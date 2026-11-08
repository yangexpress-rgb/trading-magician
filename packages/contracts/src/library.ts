import type { SharedProvenanceDto } from './strategies';
import {
  BUILT_STATUSES,
  DATA_NEEDS,
  LIBRARY_CATEGORIES,
  LIBRARY_DIRECTIONS,
  LIBRARY_MATURITIES,
  LIBRARY_STATUSES,
  type BuiltStatus,
  type DataNeed,
  type LibraryDirection,
  type LibraryMaturity,
  type LibraryParameter,
  type LibraryUniverse,
  type PositionSizing,
  type RebalanceScheduleValue,
  type StopLoss,
  type ConventionCode,
  type ConventionPosition,
  type ConventionVersion,
  type LibraryCategory,
  type LibraryDuration,
  type LibrarySource,
  type LibraryStatus,
  type MeasuredDuration,
  type UsedBy,
} from '@tm/domain';
import { z } from 'zod';

/**
 * Request and response shapes for /api/v1/library (ADR 0051). Bodies are
 * validated with the schemas in @tm/domain (register, edit, retire), which the
 * database layer checks again. Dates travel as ISO strings.
 */
export {
  editLibraryEntrySchema as editLibraryEntryRequest,
  registerLibraryEntrySchema as registerLibraryEntryRequest,
  retireLibraryEntrySchema as retireLibraryEntryRequest,
  type EditLibraryEntryInput as EditLibraryEntryRequest,
  type RegisterLibraryEntryInput as RegisterLibraryEntryRequest,
} from '@tm/domain';

const letter = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]$/)
  .optional();

/** Query string for GET /library. */
export const listLibraryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  asset: letter,
  timeframe: letter,
  category: z.enum(LIBRARY_CATEGORIES).optional(),
  built: z.enum(BUILT_STATUSES).optional(),
  /** The strategy's direction (long only, ...); `direction` below is the sort order. */
  side: z.enum(LIBRARY_DIRECTIONS).optional(),
  maturity: z.enum(LIBRARY_MATURITIES).optional(),
  /** Entries that need this data. */
  data: z.enum(DATA_NEEDS).optional(),
  status: z.enum([...LIBRARY_STATUSES, 'all']).default('all'),
  /** Records you registered, or copies shared with you (ADR 0056). */
  mine: z.enum(['registered', 'shared']).optional(),
  sort: z.enum(['number', 'name', 'registered']).default('number'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});
export type ListLibraryQuery = z.input<typeof listLibraryQuery>;

/** Query string for GET /library/next-number. */
export const nextNumberQuery = z.object({
  recordType: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]$/)
    .default('S'),
  timeframe: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]$/, 'Choose a timeframe'),
  asset: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]$/, 'Choose an asset class'),
});

export type ActorLabelDto = 'seed' | 'you' | 'member' | 'former_member' | 'system';

export interface LibraryEntrySummaryDto {
  id: string;
  registrationNumber: string;
  sequenceNo: number;
  conventionVersion: string;
  recordTypeCode: string;
  timeframeCode: string;
  assetClassCode: string;
  name: string;
  category: LibraryCategory;
  tags: string[];
  status: LibraryStatus;
  builtStatus: BuiltStatus;
  shortDescription: string;
  assets: string;
  registeredAt: string;
  /** Numbers it had before a renumbering (ADR 0055); they still resolve to it. */
  formerNumbers: string[];
  direction: LibraryDirection | null;
  maturity: LibraryMaturity;
  dataNeeds: DataNeed[];
}

export interface LibraryListDto {
  items: LibraryEntrySummaryDto[];
  total: number;
}

export interface LibraryEntryDto extends LibraryEntrySummaryDto {
  longDescription: string;
  dataRequirements: string | null;
  entry: string;
  exit: string;
  frequency: MeasuredDuration;
  turnaround: LibraryDuration;
  usedBy: UsedBy[];
  trackRecord: string | null;
  backtestSummary: string | null;
  sources: LibrarySource[];
  parameters: LibraryParameter[];
  positionSizing: PositionSizing | null;
  stopLoss: StopLoss | null;
  rebalanceSchedule: RebalanceScheduleValue | null;
  keyRisks: string | null;
  universe: LibraryUniverse | null;
  relatedEntries: {
    registrationNumber: string;
    name: string | null;
    status: LibraryStatus | null;
  }[];
  builtStrategyId: string | null;
  builtStrategy:
    | { visibility: 'yours'; id: string; name: string; archived: boolean }
    | { visibility: 'yours_deleted'; id: string }
    | { visibility: 'elsewhere' }
    | null;
  /** A shared copy (ADR 0056): the number it was copied from. */
  copiedFrom: string | null;
  /** Who shared it; only the sender and the recipient see it. */
  sharedBy: SharedProvenanceDto | null;
  retiredReason: string | null;
  retiredAt: string | null;
  registeredBy: ActorLabelDto;
  updatedBy: ActorLabelDto;
  updatedAt: string;
  rowVersion: number;
  letters: Record<ConventionPosition, ConventionCode | null>;
  revisions: {
    action: 'create' | 'edit' | 'retire';
    note: string;
    changedFields: string[];
    editedAt: string;
    editedBy: ActorLabelDto;
  }[];
}

export interface RegisteredLibraryEntryDto {
  id: string;
  registrationNumber: string;
  conventionVersion: string;
}

export interface NextNumberDto {
  registrationNumber: string;
  conventionVersion: string;
}

export interface ConventionListDto {
  current: string;
  versions: ConventionVersion[];
}
