import type { LibraryEntryDto } from '@tm/contracts';
import {
  LIBRARY_DIRECTIONS,
  LIBRARY_MATURITIES,
  LIBRARY_V2_FIELD_LABELS,
  LIBRARY_V2_FIELD_NAMES,
  DATA_NEEDS,
  isEmptyLibraryV2Value,
  type DataNeed,
  type LibraryDirection,
  type LibraryMaturity,
  type LibraryV2FieldName,
} from '@tm/domain';

/**
 * The Strategy profile part of the Library edit form (ADR 0055): loading the
 * stored values into form state, turning form state back into the record, and
 * the checks that keep a save from wiping a stored field the form did not load.
 */

export interface ParameterDraft {
  name: string;
  value: string;
  unit: string;
}

/** A method or kind plus its detail (sizing, stop, schedule, universe). */
export interface PairDraft {
  choice: string;
  detail: string;
}

export interface ProfileDraft {
  direction: LibraryDirection | '';
  parameters: ParameterDraft[];
  sizing: PairDraft;
  stop: PairDraft;
  schedule: PairDraft;
  universe: PairDraft;
  maturity: LibraryMaturity;
  keyRisks: string;
  dataNeeds: DataNeed[];
}

type StoredProfile = Partial<Pick<LibraryEntryDto, LibraryV2FieldName>>;

const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

function toPair(value: unknown, key: 'method' | 'schedule' | 'kind'): PairDraft {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return { choice: str(v[key]) || 'unspecified', detail: str(v.detail) };
}

/**
 * The form state for an entry's stored profile, in stored order. Reads the
 * stored jsonb defensively: a value stored as a number or with no unit still
 * loads, so the form never opens empty over a stored list.
 */
export function loadProfileDraft(entry: StoredProfile | undefined): ProfileDraft {
  const params = Array.isArray(entry?.parameters) ? entry.parameters : [];
  const direction = entry?.direction;
  const maturity = entry?.maturity;
  const needs: readonly string[] = Array.isArray(entry?.dataNeeds) ? entry.dataNeeds : [];
  return {
    direction:
      direction && (LIBRARY_DIRECTIONS as readonly string[]).includes(direction) ? direction : '',
    parameters: params.map((p) => {
      const r = (p ?? {}) as unknown as Record<string, unknown>;
      return { name: str(r.name), value: str(r.value), unit: str(r.unit) };
    }),
    sizing: toPair(entry?.positionSizing, 'method'),
    stop: toPair(entry?.stopLoss, 'method'),
    schedule: toPair(entry?.rebalanceSchedule, 'schedule'),
    universe: toPair(entry?.universe, 'kind'),
    maturity:
      maturity && (LIBRARY_MATURITIES as readonly string[]).includes(maturity)
        ? maturity
        : 'researched',
    keyRisks: str(entry?.keyRisks),
    dataNeeds: DATA_NEEDS.filter((d) => needs.includes(d)),
  };
}

/**
 * Back to the record. "Not specified" with no detail stays null when it was
 * null, so an untouched field does not count as a change.
 */
function fromPair(d: PairDraft, key: string, wasNull: boolean): unknown {
  if (d.choice === 'unspecified' && !d.detail.trim() && wasNull) return null;
  return { [key]: d.choice, ...(d.detail.trim() ? { detail: d.detail } : {}) };
}

export function profileToRecord(
  d: ProfileDraft,
  entry: StoredProfile | undefined,
): Record<LibraryV2FieldName, unknown> {
  return {
    direction: d.direction || null,
    parameters: d.parameters.map((p) => ({
      name: p.name,
      value: p.value,
      ...(p.unit.trim() ? { unit: p.unit } : {}),
    })),
    positionSizing: fromPair(d.sizing, 'method', !entry?.positionSizing),
    stopLoss: fromPair(d.stop, 'method', !entry?.stopLoss),
    rebalanceSchedule: fromPair(d.schedule, 'schedule', !entry?.rebalanceSchedule),
    maturity: d.maturity,
    keyRisks: d.keyRisks,
    dataNeeds: d.dataNeeds,
    universe: fromPair(d.universe, 'kind', !entry?.universe),
  };
}

/**
 * Fields the form opened empty although the entry stores a value: the form
 * failed to load them, so a save would wipe them.
 */
export function unloadedProfileFields(
  entry: StoredProfile | undefined,
  loaded: ProfileDraft,
): LibraryV2FieldName[] {
  if (!entry) return [];
  const opened = profileToRecord(loaded, entry);
  return LIBRARY_V2_FIELD_NAMES.filter(
    (f) => !isEmptyLibraryV2Value(f, entry[f]) && isEmptyLibraryV2Value(f, opened[f]),
  );
}

/** Fields that opened with a value and the editor has since emptied, on purpose. */
export function clearedProfileFields(
  entry: StoredProfile | undefined,
  loaded: ProfileDraft,
  current: ProfileDraft,
): LibraryV2FieldName[] {
  const before = profileToRecord(loaded, entry);
  const now = profileToRecord(current, entry);
  return LIBRARY_V2_FIELD_NAMES.filter(
    (f) => !isEmptyLibraryV2Value(f, before[f]) && isEmptyLibraryV2Value(f, now[f]),
  );
}

export function unloadedFieldsMessage(fields: LibraryV2FieldName[]): string {
  const names = fields.map((f) => LIBRARY_V2_FIELD_LABELS[f]).join(', ');
  return `Not saved: ${names} did not load into the form, and saving would clear what is stored. Reload the page and try again.`;
}
