import { describe, expect, it } from 'vitest';
import {
  composeRegistrationNumber,
  ConventionCodeError,
  type ConventionVersion,
  currentConvention,
  formatSequence,
  interpretRegistrationNumber,
  parseRegistrationNumber,
} from './convention';
import { formatDuration, frequencySchema, turnaroundSchema } from './duration';
import { editLibraryEntrySchema, registerLibraryEntrySchema } from './entry';
import { parseMarkdown } from './markdown';

/** The v1 tables as migration 0067 seeds them (the database is the source). */
const V1: ConventionVersion = {
  label: 'v1',
  effectiveFrom: '2026-11-07',
  tables: {
    recordType: [{ code: 'S', meaning: 'Strategy' }],
    timeframe: ['S', 'N', 'H', 'D', 'W', 'M', 'Q', 'Y'].map((code) => ({ code, meaning: code })),
    assetClass: ['S', 'E', 'F', 'U', 'O', 'B', 'C', 'G', 'A'].map((code) => ({
      code,
      meaning: code,
    })),
  },
};

const codes = (timeframe: string, assetClass: string) => ({
  recordType: 'S',
  timeframe,
  assetClass,
});

describe('registration numbers (convention v1)', () => {
  // A3: the worked examples, with their place in seed order as the sequence.
  it.each([
    ['D', 'S', 1, 'SDS-0001'],
    ['M', 'S', 2, 'SMS-0002'],
    ['Y', 'S', 7, 'SYS-0007'],
    ['M', 'E', 8, 'SME-0008'],
    ['Q', 'S', 12, 'SQS-0012'],
    ['S', 'A', 17, 'SSA-0017'],
  ])('composes %s/%s #%i as %s', (timeframe, asset, seq, expected) => {
    expect(composeRegistrationNumber(V1, codes(timeframe, asset), seq)).toBe(expected);
  });

  it('pads to four digits and grows to five without re-padding', () => {
    expect(formatSequence(1)).toBe('0001');
    expect(formatSequence(9999)).toBe('9999');
    expect(formatSequence(10000)).toBe('10000');
    expect(() => formatSequence(0)).toThrow(RangeError);
    expect(() => formatSequence(1.5)).toThrow(RangeError);
  });

  it('rejects codes the version does not define', () => {
    expect(() => composeRegistrationNumber(V1, codes('T', 'S'), 1)).toThrow(ConventionCodeError);
    expect(() => composeRegistrationNumber(V1, codes('D', 'X'), 1)).toThrow(/Asset class/);
    expect(() =>
      composeRegistrationNumber(V1, { recordType: 'P', timeframe: 'D', assetClass: 'S' }, 1),
    ).toThrow(/Record type/);
  });

  it('parses well-formed numbers only', () => {
    expect(parseRegistrationNumber('sds-0001')).toEqual({ codes: codes('D', 'S'), sequence: 1 });
    expect(parseRegistrationNumber('SDS-10000')?.sequence).toBe(10000);
    for (const bad of ['SDS-001', 'SD-0001', 'SDS0001', 'SDS-0000', 'SDS-00001', '']) {
      expect(parseRegistrationNumber(bad)).toBeNull();
    }
  });

  // A1 (pure part): a later version adds a code; older numbers read through v1.
  it('reads each number through the version that issued it', () => {
    const v2: ConventionVersion = {
      label: 'v2',
      effectiveFrom: '2027-01-01',
      tables: {
        ...V1.tables,
        timeframe: [
          ...V1.tables.timeframe,
          { code: 'T', meaning: 'Ticks' },
          // v2 renames a v1 meaning: old numbers keep the v1 meaning.
        ].map((c) => (c.code === 'D' ? { code: 'D', meaning: 'Trading days' } : c)),
      },
    };
    expect(currentConvention([V1, v2], new Date('2026-12-31T23:00:00Z'))?.label).toBe('v1');
    expect(currentConvention([V1, v2], new Date('2027-01-01T00:00:00Z'))?.label).toBe('v2');
    expect(currentConvention([V1, v2], new Date('2026-01-01T00:00:00Z'))).toBeUndefined();
    expect(composeRegistrationNumber(v2, codes('T', 'S'), 19)).toBe('STS-0019');
    expect(interpretRegistrationNumber('SDS-0001', V1)?.timeframe?.meaning).toBe('D');
    expect(interpretRegistrationNumber('SDS-0001', v2)?.timeframe?.meaning).toBe('Trading days');
  });
});

describe('durations', () => {
  // A4 (rendering) and A5.
  it('renders with units and range', () => {
    expect(formatDuration({ kind: 'every', value: 1, unit: 'months' })).toBe('1 month');
    expect(formatDuration({ kind: 'every', value: 5, unit: 'days', low: 2, high: 10 })).toBe(
      '5 days (range 2–10 days)',
    );
    expect(formatDuration({ kind: 'per', value: 3, unit: 'years', low: 2, high: 4 })).toBe(
      '2–4 per year (typically 3)',
    );
    expect(formatDuration({ kind: 'per', value: 12, unit: 'years' })).toBe('12 per year');
    expect(formatDuration({ kind: 'unknown' })).toBe('Unknown');
  });

  it('frequency needs a unit and is never Unknown', () => {
    expect(frequencySchema.safeParse({ kind: 'unknown' }).success).toBe(false);
    expect(frequencySchema.safeParse({ kind: 'every', value: 1 }).success).toBe(false);
    expect(frequencySchema.safeParse({ kind: 'every', value: 1, unit: 'months' }).success).toBe(
      true,
    );
  });

  it('turnaround may be Unknown but not a count per period', () => {
    expect(turnaroundSchema.safeParse({ kind: 'unknown' }).success).toBe(true);
    expect(turnaroundSchema.safeParse({ kind: 'per', value: 2, unit: 'years' }).success).toBe(
      false,
    );
  });

  it('checks ranges', () => {
    const r = (low: number, value: number, high: number) =>
      frequencySchema.safeParse({ kind: 'every', value, unit: 'days', low, high }).success;
    expect(r(2, 5, 10)).toBe(true);
    expect(r(10, 5, 2)).toBe(false);
    expect(r(6, 5, 10)).toBe(false);
    expect(
      frequencySchema.safeParse({ kind: 'every', value: 5, unit: 'days', low: 2 }).success,
    ).toBe(false);
  });
});

const valid = {
  name: 'Example',
  category: 'trend',
  shortDescription: 'One line.',
  longDescription: 'How it works.',
  assets: 'SPY only',
  entry: 'Buy when the close is above the 200-day average.',
  exit: 'Sell when the close is below it.',
  frequency: { kind: 'per', value: 3, unit: 'years', low: 1, high: 6 },
  turnaround: { kind: 'unknown' },
  timeframeCode: 'D',
  assetClassCode: 'S',
};

describe('entry validation', () => {
  it('accepts a minimal record and defaults the record type to S', () => {
    const parsed = registerLibraryEntrySchema.parse(valid);
    expect(parsed.recordTypeCode).toBe('S');
    expect(parsed.usedBy).toEqual([]);
    expect(parsed.builtStrategyId).toBeNull();
  });

  it('requires what it trades, entry and exit', () => {
    for (const field of ['assets', 'entry', 'exit', 'shortDescription', 'longDescription']) {
      expect(registerLibraryEntrySchema.safeParse({ ...valid, [field]: '  ' }).success).toBe(false);
    }
  });

  it('caps the short description at 280 characters', () => {
    expect(
      registerLibraryEntrySchema.safeParse({ ...valid, shortDescription: 'x'.repeat(280) }).success,
    ).toBe(true);
    expect(
      registerLibraryEntrySchema.safeParse({ ...valid, shortDescription: 'x'.repeat(281) }).success,
    ).toBe(false);
  });

  // A10 (validation part).
  it('refuses a prior user without a source', () => {
    const usedBy = [{ who: 'A fund', what: 'Ran it', evidence: 'anecdote', source: '' }];
    const result = registerLibraryEntrySchema.safeParse({ ...valid, usedBy });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['usedBy', 0, 'source']);
  });

  it('needs a link or citation for each source, and well-formed related numbers', () => {
    expect(
      registerLibraryEntrySchema.safeParse({ ...valid, sources: [{ title: 'A paper' }] }).success,
    ).toBe(false);
    expect(
      registerLibraryEntrySchema.safeParse({ ...valid, relatedEntries: ['nope'] }).success,
    ).toBe(false);
    expect(
      registerLibraryEntrySchema.parse({ ...valid, relatedEntries: ['sds-0001', 'SDS-0001'] })
        .relatedEntries,
    ).toEqual(['SDS-0001']);
  });

  it('an edit carries no codes and needs a change note', () => {
    const fields: Record<string, unknown> = { ...valid };
    delete fields.timeframeCode;
    delete fields.assetClassCode;
    expect(editLibraryEntrySchema.safeParse({ ...fields, rowVersion: 1 }).success).toBe(false);
    expect(
      editLibraryEntrySchema.safeParse({ ...fields, rowVersion: 1, changeNote: 'Fixed typo' })
        .success,
    ).toBe(true);
    expect(
      editLibraryEntrySchema.safeParse({ ...valid, rowVersion: 1, changeNote: 'x' }).success,
    ).toBe(false);
  });
});

describe('markdown subset', () => {
  it('parses paragraphs, lists and inline marks without HTML', () => {
    const blocks = parseMarkdown(
      'First **bold** and *em* with `code`.\nSame paragraph.\n\n- one\n- two [link](https://example.com)\n\n1. a\n2. b\n\n<script>x</script>',
    );
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph' });
    expect(blocks[1]).toMatchObject({ kind: 'list', ordered: false });
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: true });
    expect(blocks[3]).toEqual({
      kind: 'paragraph',
      inlines: [{ kind: 'text', text: '<script>x</script>' }],
    });
    const items = blocks[1]!.kind === 'list' ? blocks[1]!.items : [];
    expect(items[1]).toContainEqual({ kind: 'link', text: 'link', href: 'https://example.com' });
  });

  it('ignores links that are not http(s)', () => {
    const [block] = parseMarkdown('[x](javascript:alert(1))');
    expect(block).toEqual({
      kind: 'paragraph',
      inlines: [{ kind: 'text', text: '[x](javascript:alert(1))' }],
    });
  });
});
