/**
 * Registration numbers for the Strategy Library (ADR 0051, ADR 0055).
 *
 * A number is a record-type letter, a global sequence and two more code
 * letters (asset class and timeframe), laid out as the issuing convention
 * version says: v1 is letters-first (`SDS-0001`: record type, timeframe,
 * asset class, hyphen, four digits); v2 is sequence-first (`S00001-SD`:
 * record type, five digits, hyphen, asset class, timeframe). The codes come
 * from a dated, versioned convention: the code
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

/** How a version lays out a number (ADR 0055). */
export const NUMBER_LAYOUTS = ['letters-first', 'sequence-first'] as const;
export type NumberLayout = (typeof NUMBER_LAYOUTS)[number];

/** Minimum digits in the sequence part, per layout; longer sequences are never re-padded. */
export const LAYOUT_MIN_DIGITS: Record<NumberLayout, number> = {
  'letters-first': 4,
  'sequence-first': 5,
};

export interface ConventionVersion {
  /** "v1", "v2", ... */
  label: string;
  /** First day (YYYY-MM-DD, UTC) new registrations use this version. */
  effectiveFrom: string;
  tables: ConventionTables;
  /** v1: letters-first; v2: sequence-first. Missing means letters-first (v1). */
  layout?: NumberLayout;
  /** Minimum sequence digits; missing means the layout's default. */
  sequenceDigits?: number;
}

export function layoutOf(version: Pick<ConventionVersion, 'layout'>): NumberLayout {
  return version.layout ?? 'letters-first';
}

export function sequenceDigitsOf(
  version: Pick<ConventionVersion, 'layout' | 'sequenceDigits'>,
): number {
  return version.sequenceDigits ?? LAYOUT_MIN_DIGITS[layoutOf(version)];
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

/** Minimum digits in a v1 (letters-first) sequence. Kept for v1 callers. */
export const SEQUENCE_MIN_DIGITS = LAYOUT_MIN_DIGITS['letters-first'];

export function formatSequence(sequence: number, minDigits: number = SEQUENCE_MIN_DIGITS): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError('A registration sequence is a whole number from 1');
  }
  return String(sequence).padStart(minDigits, '0');
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

/** The three code letters in v1 order (record type, timeframe, asset class). */
export function registrationLetters(codes: RegistrationCodes): string {
  return `${codes.recordType}${codes.timeframe}${codes.assetClass}`;
}

/** Lays out codes and a sequence; no convention check (see composeRegistrationNumber). */
export function layoutNumber(
  layout: NumberLayout,
  codes: RegistrationCodes,
  sequence: number,
  minDigits: number = LAYOUT_MIN_DIGITS[layout],
): string {
  const digits = formatSequence(sequence, minDigits);
  return layout === 'sequence-first'
    ? `${codes.recordType}${digits}-${codes.assetClass}${codes.timeframe}`
    : `${registrationLetters(codes)}-${digits}`;
}

/**
 * The registration number for these codes and sequence under `version`, laid
 * out as that version says. Rejects any code the version does not define.
 */
export function composeRegistrationNumber(
  version: ConventionVersion,
  codes: RegistrationCodes,
  sequence: number,
): string {
  assertCodesInConvention(version, codes);
  return layoutNumber(layoutOf(version), codes, sequence, sequenceDigitsOf(version));
}

/** v1: letters, hyphen, digits. */
const LETTERS_FIRST = /^([A-Z])([A-Z])([A-Z])-(\d+)$/;
/** v2: record type, digits, hyphen, asset class, timeframe. */
const SEQUENCE_FIRST = /^([A-Z])(\d+)-([A-Z])([A-Z])$/;

export interface ParsedRegistrationNumber {
  codes: RegistrationCodes;
  sequence: number;
  layout: NumberLayout;
}

/**
 * Splits a well-formed number of either layout; null for anything else (no
 * convention lookup). The two layouts cannot be confused: v1 starts with three
 * letters, v2 with one letter and a digit.
 */
export function parseRegistrationNumber(value: string): ParsedRegistrationNumber | null {
  const text = value.trim().toUpperCase();
  let layout: NumberLayout;
  let recordType: string;
  let timeframe: string;
  let assetClass: string;
  let digits: string;
  const v1 = LETTERS_FIRST.exec(text);
  const v2 = v1 ? null : SEQUENCE_FIRST.exec(text);
  if (v1) {
    layout = 'letters-first';
    [, recordType = '', timeframe = '', assetClass = '', digits = ''] = v1;
  } else if (v2) {
    layout = 'sequence-first';
    [, recordType = '', digits = '', assetClass = '', timeframe = ''] = v2;
  } else return null;
  const min = LAYOUT_MIN_DIGITS[layout];
  if (digits.length < min) return null;
  // More digits only once the minimum is used up: SDS-00001 and S000001-SD are not numbers.
  if (digits.length > min && digits.startsWith('0')) return null;
  const sequence = Number(digits);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { codes: { recordType, timeframe, assetClass }, sequence, layout };
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
  // A number reads only through a version of its own layout.
  if (!parsed || parsed.layout !== layoutOf(issuedUnder)) return null;
  const find = (position: ConventionPosition) =>
    issuedUnder.tables[position].find((c) => c.code === parsed.codes[position]);
  return {
    recordType: find('recordType'),
    timeframe: find('timeframe'),
    assetClass: find('assetClass'),
  };
}
