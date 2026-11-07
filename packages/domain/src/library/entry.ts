import { z } from 'zod';
import { isRegistrationNumber } from './convention';
import { frequencySchema, turnaroundSchema } from './duration';

/**
 * The standard record of a Strategy Library entry (ADR 0051): the fields a
 * person writes. The registration number, convention version, built status
 * and audit fields are set by the system and are not part of this shape.
 */

export const LIBRARY_CATEGORIES = [
  'trend',
  'mean_reversion',
  'breakout',
  'momentum',
  'value',
  'pairs_stat_arb',
  'volatility',
  'multi_factor',
  'income_options',
  'carry',
  'event_driven',
  'market_making',
  'macro',
  'other',
] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<LibraryCategory, string> = {
  trend: 'Trend',
  mean_reversion: 'Mean reversion',
  breakout: 'Breakout',
  momentum: 'Momentum',
  value: 'Value',
  pairs_stat_arb: 'Pairs / statistical arbitrage',
  volatility: 'Volatility',
  multi_factor: 'Multi-factor',
  income_options: 'Income / options',
  carry: 'Carry',
  event_driven: 'Event-driven',
  market_making: 'Market making',
  macro: 'Macro',
  other: 'Other',
};

/** How solid a prior-use claim is; shown next to the name, never hidden in prose. */
export const EVIDENCE_LEVELS = [
  'paper',
  'book',
  'fund_filing',
  'public_statement',
  'anecdote',
  'inferred',
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const EVIDENCE_LABELS: Record<EvidenceLevel, string> = {
  paper: 'Paper',
  book: 'Book',
  fund_filing: 'Fund filing / 13F',
  public_statement: 'Public statement',
  anecdote: 'Anecdote',
  inferred: 'Inferred',
};

export const LIBRARY_STATUSES = ['registered', 'retired'] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

export const BUILT_STATUSES = ['built', 'not_built'] as const;
export type BuiltStatus = (typeof BUILT_STATUSES)[number];

export const SHORT_DESCRIPTION_MAX = 280;

const text = (label: string, max: number) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label}: use ${max.toLocaleString('en-US')} characters or fewer`);

const optionalText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label}: use ${max.toLocaleString('en-US')} characters or fewer`)
    .optional()
    .transform((v) => (v ? v : undefined));

const code = (label: string) =>
  z
    .string({ error: `Choose a ${label}` })
    .trim()
    .regex(/^[A-Z]$/, `Choose a ${label}`);

/** A prior user. The source is required: never name a user without one. */
export const usedBySchema = z
  .object({
    who: text('Who', 200),
    what: text('What they did', 500),
    evidence: z.enum(EVIDENCE_LEVELS, { error: 'Choose an evidence level' }),
    source: text('Source (link or citation)', 1000),
  })
  .strict();
export type UsedBy = z.infer<typeof usedBySchema>;

export const sourceSchema = z
  .object({
    title: text('Source title', 300),
    url: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .transform((v) => (v ? v : undefined))
      .refine((v) => v === undefined || /^https?:\/\/[^\s]+$/i.test(v), {
        message: 'Use a full http(s) link',
      }),
    citation: optionalText('Citation', 1000),
  })
  .strict()
  .refine((s) => s.url !== undefined || s.citation !== undefined, {
    message: 'Give a link or a citation',
    path: ['url'],
  });
export type LibrarySource = z.infer<typeof sourceSchema>;

const tags = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .min(1)
      .max(32, 'Tags are 32 characters at most')
      .regex(/^[a-z0-9][a-z0-9 /&+.-]*$/, 'Tags use letters, digits, spaces and - / & + .'),
  )
  .max(20, 'Use up to 20 tags')
  .transform((t) => [...new Set(t)]);

const related = z
  .array(
    z
      .string()
      .trim()
      .toUpperCase()
      .refine(isRegistrationNumber, 'Use registration numbers such as ABC-0001'),
  )
  .max(50)
  .transform((r) => [...new Set(r)]);

/** Fields every entry carries, whether registering or editing. */
export const libraryEntryFields = z
  .object({
    name: text('Name', 120),
    category: z.enum(LIBRARY_CATEGORIES, { error: 'Choose a category' }),
    tags: tags.default([]),
    shortDescription: text('Short description', SHORT_DESCRIPTION_MAX),
    longDescription: text('Long description', 20_000),
    assets: text('Assets', 500),
    dataRequirements: optionalText('Data requirements', 4000),
    entry: text('Entry', 10_000),
    exit: text('Exit', 10_000),
    frequency: frequencySchema,
    turnaround: turnaroundSchema,
    usedBy: z.array(usedBySchema).max(50).default([]),
    trackRecord: optionalText('Track record', 10_000),
    backtestSummary: optionalText('Back test summary', 500),
    sources: z.array(sourceSchema).max(50).default([]),
    relatedEntries: related.default([]),
    builtStrategyId: z.uuid('Pick a strategy').nullable().default(null),
  })
  .strict();

/** Registration: the record plus the codes that become letters 1–3 of the number. */
export const registerLibraryEntrySchema = libraryEntryFields
  .extend({
    recordTypeCode: code('record type').default('S'),
    timeframeCode: code('timeframe'),
    assetClassCode: code('asset class'),
  })
  .strict();
export type RegisterLibraryEntryInput = z.input<typeof registerLibraryEntrySchema>;
export type RegisterLibraryEntry = z.output<typeof registerLibraryEntrySchema>;

/** An edit: every person-written field, plus a required change note. */
export const editLibraryEntrySchema = libraryEntryFields
  .extend({
    changeNote: text('Change note', 500),
    rowVersion: z.number().int().positive(),
  })
  .strict();
export type EditLibraryEntryInput = z.input<typeof editLibraryEntrySchema>;
export type EditLibraryEntry = z.output<typeof editLibraryEntrySchema>;

export const retireLibraryEntrySchema = z
  .object({
    reason: text('Reason', 500),
    rowVersion: z.number().int().positive(),
  })
  .strict();
export type RetireLibraryEntry = z.output<typeof retireLibraryEntrySchema>;
