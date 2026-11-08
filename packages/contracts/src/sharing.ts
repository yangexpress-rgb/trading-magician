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
    record: Omit<RegisterLibraryEntryInput, 'builtStrategyId'>;
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
