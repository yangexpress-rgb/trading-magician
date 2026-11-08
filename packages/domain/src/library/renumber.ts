import { layoutNumber, parseRegistrationNumber } from './convention';

/**
 * The convention v2 renumbering (ADR 0055, brief "Strategy Library v2" §1.3).
 *
 * Every v1 number is rewritten mechanically: the sequence stays, the suffix is
 * the entry's asset-class letter then its timeframe letter, and the sequence
 * is padded to five digits. The migration composes each new number from the
 * entry's stored codes, never from the old number string, and checks it
 * against this table; any difference stops the whole run.
 */

/** The brief's mapping table, old → new, exactly as written (31 rows). */
export const LIBRARY_V2_RENUMBER_TABLE: readonly { seq: number; old: string; new: string }[] = [
  { seq: 1, old: 'SDS-0001', new: 'S00001-SD' },
  { seq: 2, old: 'SMS-0002', new: 'S00002-SM' },
  { seq: 3, old: 'SDS-0003', new: 'S00003-SD' },
  { seq: 4, old: 'SDS-0004', new: 'S00004-SD' },
  { seq: 5, old: 'SDS-0005', new: 'S00005-SD' },
  { seq: 6, old: 'SDS-0006', new: 'S00006-SD' },
  { seq: 7, old: 'SYS-0007', new: 'S00007-SY' },
  { seq: 8, old: 'SME-0008', new: 'S00008-EM' },
  { seq: 9, old: 'SMS-0009', new: 'S00009-SM' },
  { seq: 10, old: 'SMO-0010', new: 'S00010-OM' },
  { seq: 11, old: 'SMO-0011', new: 'S00011-OM' },
  { seq: 12, old: 'SQS-0012', new: 'S00012-SQ' },
  { seq: 13, old: 'SMA-0013', new: 'S00013-AM' },
  { seq: 14, old: 'SMS-0014', new: 'S00014-SM' },
  { seq: 15, old: 'SDA-0015', new: 'S00015-AD' },
  { seq: 16, old: 'SDO-0016', new: 'S00016-OD' },
  { seq: 17, old: 'SSA-0017', new: 'S00017-AS' },
  { seq: 18, old: 'SMA-0018', new: 'S00018-AM' },
  { seq: 19, old: 'SNS-0019', new: 'S00019-SN' },
  { seq: 20, old: 'SNS-0020', new: 'S00020-SN' },
  { seq: 21, old: 'SNS-0021', new: 'S00021-SN' },
  { seq: 22, old: 'SNS-0022', new: 'S00022-SN' },
  { seq: 23, old: 'SNS-0023', new: 'S00023-SN' },
  { seq: 24, old: 'SNS-0024', new: 'S00024-SN' },
  { seq: 25, old: 'SNS-0025', new: 'S00025-SN' },
  { seq: 26, old: 'SDS-0026', new: 'S00026-SD' },
  { seq: 27, old: 'SSA-0027', new: 'S00027-AS' },
  { seq: 28, old: 'SSS-0028', new: 'S00028-SS' },
  { seq: 29, old: 'SSS-0029', new: 'S00029-SS' },
  { seq: 30, old: 'SSA-0030', new: 'S00030-AS' },
  { seq: 31, old: 'SSF-0031', new: 'S00031-FS' },
];

/** The v2 number for a v1 number, by its own codes (mechanical; null if not a v1 number). */
export function v2NumberFor(v1Number: string): string | null {
  const parsed = parseRegistrationNumber(v1Number);
  if (!parsed || parsed.layout !== 'letters-first') return null;
  return layoutNumber('sequence-first', parsed.codes, parsed.sequence);
}

export const RENUMBER_V2_FIELDS = ['registrationNumber', 'conventionVersion'] as const;

export function renumberV2Note(newNumber: string, oldNumber: string): string {
  return `Renumbered to ${newNumber} under convention v2 (formerly ${oldNumber})`;
}
