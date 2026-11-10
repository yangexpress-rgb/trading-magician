import type { RegisterLibraryEntryInput } from '@tm/domain';

/** Strategy sharing (ADR 0056): what the /shares and /members endpoints return. */

export type ShareKindDto = 'library' | 'lab';
export type ShareStatusDto = 'pending' | 'accepted' | 'declined' | 'withdrawn' | 'expired';

export interface ShareSummaryDto {
  id: string;
  kind: ShareKindDto;
  status: ShareStatusDto;
  role: 'sender' | 'recipient';
  sender: { name: string | null; code: string; isAdmin: boolean; label: string };
  recipient: { name: string | null; code: string; label: string };
  sourceNumber: string;
  sourceName: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  result: { number: string | null; strategyId: string | null } | null;
}

export interface ShareDetailDto extends ShareSummaryDto {
  snapshot: {
    /** A Library share, and Lab shares made before ADR 0072. */
    record?: Omit<RegisterLibraryEntryInput, 'builtStrategyId'>;
    /** A Lab share since ADR 0072: the theory its strategy refers to, or null. */
    theory?: { registrationNumber: string; name: string } | null;
    strategy?: { name: string; description: string; tags: string[]; definition: unknown };
  };
}

export interface ShareListDto {
  items: ShareSummaryDto[];
}

export interface AcceptedShareDto {
  kind: ShareKindDto;
  number: string;
  strategyId: string | null;
}

export interface ShareMemberDto {
  memberCode: string;
  displayName: string;
  isAdmin: boolean;
}

export type ShareSourceDto =
  { kind: 'library'; number: string } | { kind: 'lab'; strategyId: string };

/**
 * Body of POST /shares: one `source` or several `sources`, and member IDs or
 * emails (or the admin's All members). Each source goes to each person.
 */
export interface CreateShareRequest {
  source?: ShareSourceDto;
  sources?: ShareSourceDto[];
  recipients?: string[];
  allMembers?: boolean;
  note?: string;
}
