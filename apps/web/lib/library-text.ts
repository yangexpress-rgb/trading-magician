import type { ActorLabelDto } from '@tm/contracts';
import type { BuiltStatus, ConventionCode, ConventionVersion } from '@tm/domain';

/** Text for the Strategy Library pages (ADR 0051). */

export const BUILT_LABELS: Record<BuiltStatus, string> = {
  built: 'Built',
  not_built: 'Not built',
};

export const ACTOR_LABELS: Record<ActorLabelDto, string> = {
  seed: 'the seed catalogue',
  you: 'you',
  member: 'another member',
  former_member: 'a former member',
};

export function codeMeaning(codes: readonly ConventionCode[], code: string): string {
  return codes.find((c) => c.code === code)?.meaning ?? code;
}

/** Index of each version's tables by label, to read a number through its own version. */
export function versionsByLabel(versions: readonly ConventionVersion[]) {
  return new Map(versions.map((v) => [v.label, v.tables]));
}

/** "Days (D)": the meaning first, the letter after. */
export function codeOption(c: ConventionCode): string {
  return `${c.meaning} (${c.code})`;
}

export const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  category: 'Category',
  tags: 'Tags',
  shortDescription: 'Short description',
  longDescription: 'Long description',
  assets: 'Assets',
  dataRequirements: 'Data requirements',
  entry: 'Entry',
  exit: 'Exit',
  frequency: 'Frequency',
  turnaround: 'Turnaround time',
  usedBy: 'Used by',
  trackRecord: 'Track record',
  backtestSummary: 'Back test summary',
  sources: 'Sources',
  relatedEntries: 'Related entries',
  builtStrategyId: 'Built strategy link',
  status: 'Status',
};
