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
      .refine(isRegistrationNumber, 'Use registration numbers such as S00001-SD'),
  )
  .max(50)
  .transform((r) => [...new Set(r)]);

// ---------------------------------------------------------------------------
// The fuller record (ADR 0055, brief "Strategy Library v2" §2). The Library
// records a strategy's design; the Lab holds the executable definition, so
// none of these duplicates a Lab rule. Every field is optional except
// maturity, which defaults to researched. "Not specified" is a real answer.
// ---------------------------------------------------------------------------

export const LIBRARY_DIRECTIONS = [
  'long_only',
  'short_only',
  'long_short',
  'market_neutral',
] as const;
export type LibraryDirection = (typeof LIBRARY_DIRECTIONS)[number];
export const DIRECTION_LABELS: Record<LibraryDirection, string> = {
  long_only: 'Long only',
  short_only: 'Short only',
  long_short: 'Long and short',
  market_neutral: 'Market neutral',
};

export const SIZING_METHODS = [
  'fixed_notional',
  'pct_equity',
  'risk_based',
  'equal_weight',
  'other',
  'unspecified',
] as const;
export type SizingMethod = (typeof SIZING_METHODS)[number];
export const SIZING_LABELS: Record<SizingMethod, string> = {
  fixed_notional: 'Fixed amount',
  pct_equity: 'Percent of equity',
  risk_based: 'Risk-based',
  equal_weight: 'Equal weight',
  other: 'Other',
  unspecified: 'Not specified',
};

export const STOP_METHODS = [
  'none',
  'atr_multiple',
  'pct_stop',
  'time_stop',
  'condition_based',
  'other',
  'unspecified',
] as const;
export type StopMethod = (typeof STOP_METHODS)[number];
export const STOP_LABELS: Record<StopMethod, string> = {
  none: 'No stop',
  atr_multiple: 'ATR multiple',
  pct_stop: 'Percent stop',
  time_stop: 'Time stop',
  condition_based: 'Condition-based',
  other: 'Other',
  unspecified: 'Not specified',
};

export const REBALANCE_SCHEDULES = [
  'none',
  'daily_close',
  'weekly',
  'month_end',
  'quarter_end',
  'year_end',
  'event_driven',
  'unspecified',
] as const;
export type RebalanceSchedule = (typeof REBALANCE_SCHEDULES)[number];
export const REBALANCE_LABELS: Record<RebalanceSchedule, string> = {
  none: 'No schedule',
  daily_close: 'Daily close',
  weekly: 'Weekly',
  month_end: 'Monthly',
  quarter_end: 'Quarterly',
  year_end: 'Yearly',
  event_driven: 'Event-driven',
  unspecified: 'Not specified',
};

export const LIBRARY_MATURITIES = ['researched', 'backtested', 'paper_trading', 'live'] as const;
export type LibraryMaturity = (typeof LIBRARY_MATURITIES)[number];
export const MATURITY_LABELS: Record<LibraryMaturity, string> = {
  researched: 'Researched',
  backtested: 'Back tested',
  paper_trading: 'Paper trading',
  live: 'Live',
};

export const DATA_NEEDS = [
  'daily_bars',
  'intraday_bars',
  'fundamentals',
  'options_chains',
  'earnings_consensus',
  'news',
  'level2_tick',
  'short_borrow',
  'index_data',
] as const;
export type DataNeed = (typeof DATA_NEEDS)[number];
export const DATA_NEED_LABELS: Record<DataNeed, string> = {
  daily_bars: 'Daily bars',
  intraday_bars: 'Intraday bars',
  fundamentals: 'Fundamentals',
  options_chains: 'Option chains',
  earnings_consensus: 'Earnings consensus',
  news: 'News',
  level2_tick: 'Level 2 / tick data',
  short_borrow: 'Short borrow',
  index_data: 'Index data',
};

export const UNIVERSE_KINDS = [
  'single_instrument',
  'list',
  'index_members',
  'sector_etfs',
  'broad_us_stocks',
  'multi_asset',
  'unspecified',
] as const;
export type UniverseKind = (typeof UNIVERSE_KINDS)[number];
export const UNIVERSE_LABELS: Record<UniverseKind, string> = {
  single_instrument: 'Single instrument',
  list: 'Fixed list',
  index_members: 'Index members',
  sector_etfs: 'Sector ETFs',
  broad_us_stocks: 'Broad US stocks',
  multi_asset: 'Multi-asset',
  unspecified: 'Not specified',
};

export const PARAMETERS_MAX = 10;

export const parameterSchema = z
  .object({
    name: text('Parameter name', 80),
    value: text('Parameter value', 120),
    unit: optionalText('Unit', 20),
  })
  .strict();
export type LibraryParameter = z.infer<typeof parameterSchema>;

const detail = optionalText('Detail', 500);

export const positionSizingSchema = z
  .object({ method: z.enum(SIZING_METHODS, { error: 'Choose a sizing method' }), detail })
  .strict();
export type PositionSizing = z.infer<typeof positionSizingSchema>;

export const stopLossSchema = z
  .object({ method: z.enum(STOP_METHODS, { error: 'Choose a stop method' }), detail })
  .strict();
export type StopLoss = z.infer<typeof stopLossSchema>;

export const rebalanceScheduleSchema = z
  .object({ schedule: z.enum(REBALANCE_SCHEDULES, { error: 'Choose a schedule' }), detail })
  .strict();
export type RebalanceScheduleValue = z.infer<typeof rebalanceScheduleSchema>;

export const libraryUniverseSchema = z
  .object({ kind: z.enum(UNIVERSE_KINDS, { error: 'Choose a universe kind' }), detail })
  .strict();
export type LibraryUniverse = z.infer<typeof libraryUniverseSchema>;

/** The nine v2 fields, as their own shape (the backfill and the form use it too). */
export const libraryV2Fields = z
  .object({
    direction: z.enum(LIBRARY_DIRECTIONS, { error: 'Choose a direction' }).nullable().default(null),
    parameters: z
      .array(parameterSchema)
      .max(PARAMETERS_MAX, `Use up to ${PARAMETERS_MAX} parameters`)
      .default([]),
    positionSizing: positionSizingSchema.nullable().default(null),
    stopLoss: stopLossSchema.nullable().default(null),
    rebalanceSchedule: rebalanceScheduleSchema.nullable().default(null),
    maturity: z.enum(LIBRARY_MATURITIES, { error: 'Choose a maturity' }).default('researched'),
    keyRisks: optionalText('Key risks', 4000),
    dataNeeds: z
      .array(z.enum(DATA_NEEDS, { error: 'Choose data needs from the list' }))
      .max(DATA_NEEDS.length)
      .default([])
      .transform((d) => DATA_NEEDS.filter((n) => d.includes(n))),
    universe: libraryUniverseSchema.nullable().default(null),
  })
  .strict();
export type LibraryV2Fields = z.output<typeof libraryV2Fields>;
export type LibraryV2FieldsInput = z.input<typeof libraryV2Fields>;

export const LIBRARY_V2_FIELD_NAMES = [
  'direction',
  'parameters',
  'positionSizing',
  'stopLoss',
  'rebalanceSchedule',
  'maturity',
  'keyRisks',
  'dataNeeds',
  'universe',
] as const;
export type LibraryV2FieldName = (typeof LIBRARY_V2_FIELD_NAMES)[number];

/** How the edit form and its errors name each v2 field. */
export const LIBRARY_V2_FIELD_LABELS: Record<LibraryV2FieldName, string> = {
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

/**
 * True when a v2 field holds nothing: what a form that failed to load the
 * field would send. Maturity's empty value is its default, Researched; a
 * method, schedule or kind is empty at Not specified with no detail.
 */
export function isEmptyLibraryV2Value(field: LibraryV2FieldName, value: unknown): boolean {
  if (value === null || value === undefined) return true;
  switch (field) {
    case 'parameters':
    case 'dataNeeds':
      return Array.isArray(value) && value.length === 0;
    case 'keyRisks':
      return typeof value === 'string' && value.trim() === '';
    case 'direction':
      return value === '';
    case 'maturity':
      return value === 'researched';
    case 'positionSizing':
    case 'stopLoss':
    case 'rebalanceSchedule':
    case 'universe': {
      const v = value as Record<string, unknown>;
      const choice = v.method ?? v.schedule ?? v.kind;
      const detail = typeof v.detail === 'string' ? v.detail.trim() : '';
      return (choice === undefined || choice === 'unspecified') && detail === '';
    }
  }
}

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
  .extend(libraryV2Fields.shape)
  .strict();

/** Registration: the record plus the codes that become letters 1–3 of the number. */
export const registerLibraryEntrySchema = libraryEntryFields
  .extend({
    recordTypeCode: code('record type').default('T'),
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
    /**
     * The v2 fields the editor emptied on purpose. A save that empties a
     * stored field not named here is refused: the form most likely failed to
     * load it, and saving would wipe it silently.
     */
    clearedFields: z
      .array(z.enum(LIBRARY_V2_FIELD_NAMES))
      .max(LIBRARY_V2_FIELD_NAMES.length)
      .default([]),
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
