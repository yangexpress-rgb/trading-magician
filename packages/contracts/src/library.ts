import {
  BUILT_STATUSES,
  LIBRARY_CATEGORIES,
  LIBRARY_STATUSES,
  type BuiltStatus,
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
  status: z.enum([...LIBRARY_STATUSES, 'all']).default('all'),
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

export type ActorLabelDto = 'seed' | 'you' | 'member' | 'former_member';

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
