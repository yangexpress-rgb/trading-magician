/**
 * Registration numbers for the Strategy Library (ADR 0051).
 *
 * A number is three code letters, a hyphen and a global sequence of at least
 * four digits. The letters come from a dated, versioned convention: the code
 * tables live in the database (`convention_version`), never in this file, so a
 * later version can add or rename codes without touching numbers already
 * issued. This module composes, parses and checks numbers against whatever
 * tables it is given.
 */

/** One code in a convention table. */
export interface ConventionCode {
  code: string;
  meaning: string;
  note?: string;
}

/** The three code tables of one convention version, in display order. */
export interface ConventionTables {
  /** Letter 1: what kind of record the number names. */
  recordType: ConventionCode[];
  /** Letter 2: the decision timescale, the cycle the strategy reasons on. */
  timeframe: ConventionCode[];
  /** Letter 3: what the strategy trades. */
  assetClass: ConventionCode[];
}

export interface ConventionVersion {
  /** "v1", "v2", ... */
  label: string;
  /** First day (YYYY-MM-DD, UTC) new registrations use this version. */
  effectiveFrom: string;
  tables: ConventionTables;
}

/** The codes chosen at registration, one per position. */
export interface RegistrationCodes {
  recordType: string;
  timeframe: string;
  assetClass: string;
}

export type ConventionPosition = keyof ConventionTables;

export const CONVENTION_POSITIONS: readonly ConventionPosition[] = [
  'recordType',
  'timeframe',
  'assetClass',
];

export const POSITION_LABELS: Record<ConventionPosition, string> = {
  recordType: 'Record type',
  timeframe: 'Timeframe',
  assetClass: 'Asset class',
};

export class ConventionCodeError extends Error {
  constructor(
    public readonly position: ConventionPosition,
    public readonly code: string,
    public readonly version: string,
  ) {
    super(
      `${POSITION_LABELS[position]} code "${code}" is not in convention ${version}. New codes arrive only with a new convention version.`,
    );
    this.name = 'ConventionCodeError';
  }
}

/** Minimum digits in the sequence part; longer sequences are never re-padded. */
export const SEQUENCE_MIN_DIGITS = 4;

export function formatSequence(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('A registration sequence is a whole number from 1');
  }
  return String(sequence).padStart(SEQUENCE_MIN_DIGITS, '0');
}

/** Throws ConventionCodeError when any code is not in the version's tables. */
export function assertCodesInConvention(
  version: ConventionVersion,
  codes: RegistrationCodes,
): void {
  for (const position of CONVENTION_POSITIONS) {
    const code = codes[position];
    if (!version.tables[position].some((c) => c.code === code)) {
      throw new ConventionCodeError(position, code, version.label);
    }
  }
}

export function registrationLetters(codes: RegistrationCodes): string {
  return `${codes.recordType}${codes.timeframe}${codes.assetClass}`;
}

/**
 * The registration number for these codes and sequence under `version`.
 * Rejects any code the version does not define.
 */
export function composeRegistrationNumber(
  version: ConventionVersion,
  codes: RegistrationCodes,
  sequence: number,
): string {
  assertCodesInConvention(version, codes);
  return `${registrationLetters(codes)}-${formatSequence(sequence)}`;
}

const NUMBER_PATTERN = /^([A-Z])([A-Z])([A-Z])-(\d{4,})$/;

/** Splits a well-formed number; null for anything else (no convention lookup). */
export function parseRegistrationNumber(
  value: string,
): { codes: RegistrationCodes; sequence: number } | null {
  const m = NUMBER_PATTERN.exec(value.trim().toUpperCase());
  if (!m) return null;
  const [, recordType = '', timeframe = '', assetClass = '', digits = ''] = m;
  const sequence = Number(digits);
  // Five or more digits only once four are used up: SDS-00001 is not a number.
  if (digits.length > SEQUENCE_MIN_DIGITS && digits.startsWith('0')) return null;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { codes: { recordType, timeframe, assetClass }, sequence };
}

export function isRegistrationNumber(value: string): boolean {
  return parseRegistrationNumber(value) !== null;
}

/**
 * The version new registrations use at `at`: the latest effective date on or
 * before that day. Ties go to the later-listed version.
 */
export function currentConvention(
  versions: readonly ConventionVersion[],
  at: Date = new Date(),
): ConventionVersion | undefined {
  const day = at.toISOString().slice(0, 10);
  let current: ConventionVersion | undefined;
  for (const v of versions) {
    if (v.effectiveFrom > day) continue;
    if (!current || v.effectiveFrom >= current.effectiveFrom) current = v;
  }
  return current;
}

/**
 * What a number's letters mean, read through the version that issued it
 * (stored on the entry), never through the current one.
 */
export function interpretRegistrationNumber(
  value: string,
  issuedUnder: ConventionVersion,
): Record<ConventionPosition, ConventionCode | undefined> | null {
  const parsed = parseRegistrationNumber(value);
  if (!parsed) return null;
  const find = (position: ConventionPosition) =>
    issuedUnder.tables[position].find((c) => c.code === parsed.codes[position]);
  return {
    recordType: find('recordType'),
    timeframe: find('timeframe'),
    assetClass: find('assetClass'),
  };
}
