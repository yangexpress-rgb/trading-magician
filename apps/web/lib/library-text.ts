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
  system: 'the system',
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
  registrationNumber: 'Registration number',
  conventionVersion: 'Convention version',
  direction: 'Direction',
  parameters: 'Parameters',
  positionSizing: 'Position sizing',
  stopLoss: 'Stop loss',
  rebalanceSchedule: 'Rebalance schedule',
  maturity: 'Maturity',
  keyRisks: 'Key risks',
  dataNeeds: 'Data needs',
  universe: 'Universe',
};

/** "Not specified" is an answer, shown as such (ADR 0055). */
export const NOT_SPECIFIED = 'Not specified';

/** "Equal weight — Top-decile picks held in equal weight", or Not specified. */
export function methodText(
  value: { detail?: string | undefined } | null,
  label: string | undefined,
): string {
  if (!value || !label) return NOT_SPECIFIED;
  return value.detail ? `${label} — ${value.detail}` : label;
}
