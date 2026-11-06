import { z } from 'zod';
import { BAR_INTERVALS, MARKET_FIELDS, PRICE_ADJUSTMENTS, SESSIONS } from './catalog';

/**
 * Strategy definition, schema version 1 (Design v1.0 §6, §13.2; proposal §4.5).
 *
 * A definition is a validated tree, never display text. It is stored as one
 * JSON document per immutable strategy version. Structural rules live here;
 * rules that need outside context (instruments, accounts, feeds) live in
 * validate.ts.
 */
export const STRATEGY_SCHEMA_VERSION = 1 as const;

/** Decimal values travel as strings so no precision is lost (§17.1). */
export const decimalString = z
  .string()
  .regex(/^-?\d{1,18}(\.\d{1,10})?$/, 'Must be a decimal number');
export const positiveDecimalString = decimalString.refine(
  (v) => !v.startsWith('-') && /[1-9]/.test(v),
  'Must be greater than zero',
);

const id = z.string().min(1).max(64);
export type NodeId = string;

// ---------------------------------------------------------------------------
// Expressions (§6.4). Each market or indicator expression names its own
// instrument; nothing inherits a strategy-wide symbol.
// ---------------------------------------------------------------------------

const seriesSource = {
  instrumentId: z.string().uuid({ message: 'Choose an instrument' }),
  interval: z.enum(BAR_INTERVALS),
  adjustment: z.enum(PRICE_ADJUSTMENTS).default('split_and_dividend'),
  session: z.enum(SESSIONS).default('regular'),
};

export interface ConstantExpr {
  kind: 'constant';
  id: NodeId;
  value: string;
}
export interface MarketExpr {
  kind: 'market';
  id: NodeId;
  instrumentId: string;
  field: (typeof MARKET_FIELDS)[number];
  interval: (typeof BAR_INTERVALS)[number];
  adjustment: (typeof PRICE_ADJUSTMENTS)[number];
  session: (typeof SESSIONS)[number];
  /** Bars back from the current one: 0 is the latest completed bar. */
  offset: number;
}
export interface IndicatorExpr {
  kind: 'indicator';
  id: NodeId;
  name: string;
  params: Record<string, number | string>;
  instrumentId: string;
  field: (typeof MARKET_FIELDS)[number];
  interval: (typeof BAR_INTERVALS)[number];
  adjustment: (typeof PRICE_ADJUSTMENTS)[number];
  session: (typeof SESSIONS)[number];
  offset: number;
}
/**
 * What a strategy holds in the current cycle (Design v1.0 §6.4 extension).
 * Values exist only once Entry legs have filled, so they belong in Exit rules
 * and Exit order prices. The mark is the close of the latest completed bar at
 * the expression's interval, which also sets how often the rule is checked.
 */
export const POSITION_FIELDS = ['entry_price', 'gain_pct', 'pnl', 'quantity'] as const;
export type PositionField = (typeof POSITION_FIELDS)[number];
export interface PositionExpr {
  kind: 'position';
  id: NodeId;
  instrumentId: string;
  field: PositionField;
  interval: (typeof BAR_INTERVALS)[number];
  adjustment: (typeof PRICE_ADJUSTMENTS)[number];
  session: (typeof SESSIONS)[number];
}
export const CALC_OPS = ['add', 'sub', 'mul', 'div', 'neg', 'abs', 'min', 'max'] as const;
export interface CalcExpr {
  kind: 'calc';
  id: NodeId;
  op: (typeof CALC_OPS)[number];
  args: Expr[];
}
/**
 * A named metric from the shared metric registry (v1.2 item 1, principle 3):
 * the same definition serves conditions, Selection-group ranking and the
 * screener. Metrics read daily bars; `params` follow the metric's spec.
 */
export interface MetricExpr {
  kind: 'metric';
  id: NodeId;
  metric: string;
  params: Record<string, number | string>;
  instrumentId: string;
}
/**
 * A statistical function over any expression, evaluated bar by bar over its
 * own history (v1.2 item 3): standard deviation, z-score and Bollinger bands
 * of a price, a calculated spread or another indicator, and the Bollinger
 * BandWidth (v1.2 item 5).
 */
export const STAT_FUNCTIONS = [
  'STDDEV',
  'ZSCORE',
  'BB_UPPER',
  'BB_MIDDLE',
  'BB_LOWER',
  'BANDWIDTH',
] as const;
export type StatFunction = (typeof STAT_FUNCTIONS)[number];
export interface StatExpr {
  kind: 'stat';
  id: NodeId;
  fn: StatFunction;
  input: Expr;
  period: number;
  /** Band width in standard deviations, for the Bollinger functions and BandWidth. */
  multiplier?: string | undefined;
  /** Bars back from the current one, as on market values. */
  offset?: number | undefined;
}
export type Expr =
  ConstantExpr | MarketExpr | IndicatorExpr | PositionExpr | CalcExpr | MetricExpr | StatExpr;

const offset = z.number().int().min(0).max(500).default(0);

export const constantExprSchema = z.object({
  kind: z.literal('constant'),
  id,
  value: decimalString,
});
export const marketExprSchema = z.object({
  kind: z.literal('market'),
  id,
  field: z.enum(MARKET_FIELDS),
  offset,
  ...seriesSource,
});
export const indicatorExprSchema = z.object({
  kind: z.literal('indicator'),
  id,
  name: z.string().min(1).max(32),
  params: z.record(z.string(), z.union([z.number(), z.string().max(32)])),
  field: z.enum(MARKET_FIELDS),
  offset,
  ...seriesSource,
});

export const positionExprSchema = z.object({
  kind: z.literal('position'),
  id,
  field: z.enum(POSITION_FIELDS),
  ...seriesSource,
});

export const metricExprSchema = z.object({
  kind: z.literal('metric'),
  id,
  metric: z.string().min(1).max(40),
  params: z.record(z.string(), z.union([z.number(), z.string().max(64)])),
  instrumentId: z.string().uuid({ message: 'Choose an instrument' }),
});

const statExprSchema = z.object({
  kind: z.literal('stat'),
  id,
  fn: z.enum(STAT_FUNCTIONS),
  get input(): z.ZodType<Expr> {
    return exprSchema;
  },
  period: z.number().int().min(2, 'Use at least 2 bars').max(500),
  multiplier: positiveDecimalString.optional(),
  offset: z.number().int().min(0).max(500).optional(),
});

const calcExprSchema = z
  .object({
    kind: z.literal('calc'),
    id,
    op: z.enum(CALC_OPS),
    get args(): z.ZodArray<z.ZodType<Expr>> {
      return z.array(exprSchema);
    },
  })
  .superRefine((c, ctx) => {
    const unary = c.op === 'neg' || c.op === 'abs';
    const variadic = c.op === 'min' || c.op === 'max';
    const n = c.args.length;
    const ok = unary ? n === 1 : variadic ? n >= 2 : n === 2;
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['args'],
        message: unary
          ? `${c.op} takes exactly one value`
          : variadic
            ? `${c.op} takes at least two values`
            : `${c.op} takes exactly two values`,
      });
    }
  });

export const exprSchema: z.ZodType<Expr> = z.discriminatedUnion('kind', [
  constantExprSchema,
  marketExprSchema,
  indicatorExprSchema,
  positionExprSchema,
  calcExprSchema,
  metricExprSchema,
  statExprSchema,
]);

// ---------------------------------------------------------------------------
// Conditions (§6.4): Boolean groups of comparisons with AND/OR and NOT.
// ---------------------------------------------------------------------------

export const COMPARISON_OPERATORS = [
  'lt',
  'lte',
  'gt',
  'gte',
  'eq',
  'neq',
  'crosses_above',
  'crosses_below',
  'between',
  'outside',
  'is_available',
  'is_stale',
] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];
export const UNARY_OPERATORS: readonly ComparisonOperator[] = ['is_available', 'is_stale'];
export const RANGE_OPERATORS: readonly ComparisonOperator[] = ['between', 'outside'];

export interface Comparison {
  kind: 'comparison';
  id: NodeId;
  left: Expr;
  operator: ComparisonOperator;
  /** Absent for unary operators. */
  right?: Expr | undefined;
  /** Upper bound for range operators; `right` is the lower bound. */
  upper?: Expr | undefined;
}
export interface ConditionGroup {
  kind: 'group';
  id: NodeId;
  op: 'and' | 'or';
  negate: boolean;
  children: ConditionNode[];
}
export type ConditionNode = ConditionGroup | Comparison;

export const comparisonSchema = z
  .object({
    kind: z.literal('comparison'),
    id,
    left: exprSchema,
    operator: z.enum(COMPARISON_OPERATORS),
    right: exprSchema.optional(),
    upper: exprSchema.optional(),
  })
  .superRefine((c, ctx) => {
    const unary = UNARY_OPERATORS.includes(c.operator);
    const range = RANGE_OPERATORS.includes(c.operator);
    if (!unary && !c.right) {
      ctx.addIssue({ code: 'custom', path: ['right'], message: 'Add a value to compare with' });
    }
    if (range && !c.upper) {
      ctx.addIssue({ code: 'custom', path: ['upper'], message: 'Add an upper bound' });
    }
  });

export const conditionGroupSchema = z.object({
  kind: z.literal('group'),
  id,
  op: z.enum(['and', 'or']),
  negate: z.boolean().default(false),
  get children(): z.ZodArray<z.ZodType<ConditionNode>> {
    return z.array(conditionNodeSchema);
  },
});

export const conditionNodeSchema: z.ZodType<ConditionNode> = z.discriminatedUnion('kind', [
  conditionGroupSchema,
  comparisonSchema,
]);

// ---------------------------------------------------------------------------
// Planned orders and timing (§6.6, §6.8)
// ---------------------------------------------------------------------------

export const ORDER_SIDES = [
  'buy',
  'sell',
  'sell_short',
  'buy_to_cover',
  'close',
  'reduce',
] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export const QUANTITY_TYPES = ['units', 'notional', 'pct_equity', 'risk_sized'] as const;
export const ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const TIME_IN_FORCE = ['day', 'gtc', 'ioc', 'fok'] as const;
export const RELATIVE_UNITS = ['s', 'min', 'h', 'd'] as const;
export const PHASE_EVENTS = [
  'entry_trigger',
  'entry_submitted',
  'entry_partial_fill',
  'entry_full_fill',
  'position_opened',
] as const;
export type PhaseEvent = (typeof PHASE_EVENTS)[number];
export const LEG_EVENTS = ['submitted', 'filled'] as const;

/** ISO 8601 with an explicit offset; a time without a zone is invalid (§6.8). */
const zonedTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/,
    'Enter a date and time with a time zone',
  )
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a real date and time');

export const timingSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('immediate') }),
  z.object({
    mode: z.literal('exact'),
    at: zonedTimestamp,
    /** IANA zone the user picked, kept for display; `at` carries the offset. */
    zone: z.string().min(1),
  }),
  z.object({
    mode: z.literal('relative'),
    amount: z.number().positive('Delay must be greater than zero').max(100_000),
    unit: z.enum(RELATIVE_UNITS),
    reference: z.union([
      z.object({ kind: z.literal('phase'), event: z.enum(PHASE_EVENTS) }),
      z.object({ kind: z.literal('leg'), legId: id, event: z.enum(LEG_EVENTS) }),
    ]),
  }),
]);
export type Timing = z.infer<typeof timingSchema>;

export const plannedOrderSchema = z.object({
  id,
  legLabel: z.string().trim().min(1, 'Name this leg').max(40),
  instrumentId: z.string().uuid({ message: 'Choose an instrument' }),
  accountId: z.string().uuid({ message: 'Choose an account' }),
  side: z.enum(ORDER_SIDES),
  quantity: z.object({
    type: z.enum(QUANTITY_TYPES),
    value: positiveDecimalString,
    rounding: z.enum(['down', 'nearest']).default('down'),
  }),
  orderType: z.enum(ORDER_TYPES),
  limitPrice: exprSchema.optional(),
  stopPrice: exprSchema.optional(),
  timeInForce: z.enum(TIME_IN_FORCE).default('day'),
  extendedHours: z.boolean().default(false),
  timing: timingSchema.prefault({ mode: 'immediate' }),
  /** When true, only the timing rule must qualify, not the phase condition (§6.8). */
  timingOnly: z.boolean().default(false),
  notes: z.string().max(500).optional(),
  /**
   * Entry legs only (v1.2 item 2): the leg fires only when the Entry
   * condition and this condition are both true. Expressions on the leg's
   * own instrument may use `CONTEXT_INSTRUMENT_ID`.
   */
  legCondition: conditionGroupSchema.optional(),
});
export type PlannedOrder = z.infer<typeof plannedOrderSchema>;

// ---------------------------------------------------------------------------
// Phases, execution policy and risk (§6.5, §6.7, §6.9, §8.6)
// ---------------------------------------------------------------------------

export const TRIGGER_MODES = ['on_transition', 'while_true', 'once_per_cycle'] as const;

export const phaseSchema = z.object({
  condition: conditionGroupSchema,
  trigger: z
    .object({
      mode: z.enum(TRIGGER_MODES).default('on_transition'),
      cooldownSec: z
        .number()
        .int()
        .min(0)
        .max(86_400 * 30)
        .default(0),
      confirmationBars: z.number().int().min(0).max(100).default(0),
    })
    .prefault({}),
  orders: z.array(plannedOrderSchema).max(20),
});
export type Phase = z.infer<typeof phaseSchema>;

// ---------------------------------------------------------------------------
// v1.2: Selection groups, per-leg fire mode, exit rules and the schedule.
// Every field is optional and absent on v1.1 definitions, so they parse,
// hash and run exactly as before (design principle 5).
// ---------------------------------------------------------------------------

/** A metric from the registry with its parameters (see metrics.ts). */
export const metricRefSchema = z.object({
  metric: z.string().min(1).max(40),
  params: z.record(z.string(), z.union([z.number(), z.string().max(64)])).default({}),
});
export type MetricRef = z.infer<typeof metricRefSchema>;

export const BUILTIN_UNIVERSES = ['sp500'] as const;
export type BuiltinUniverse = (typeof BUILTIN_UNIVERSES)[number];

export const universeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('builtin'), id: z.enum(BUILTIN_UNIVERSES) }),
  z.object({
    type: z.literal('list'),
    instrumentIds: z
      .array(z.string().uuid({ message: 'Choose an instrument' }))
      .min(1, 'Add at least one instrument to the list')
      .max(600),
  }),
]);
export type Universe = z.infer<typeof universeSchema>;

export const selectionSchema = z.object({
  universe: universeSchema,
  ranking: metricRefSchema,
  /** Highest value first, or lowest first (cheapest by P/E style). */
  direction: z.enum(['desc', 'asc']),
  count: z.discriminatedUnion('type', [
    z.object({ type: z.literal('fixed'), value: z.number().int().min(1).max(600) }),
    z.object({ type: z.literal('percent'), value: z.number().gt(0).max(100) }),
  ]),
  /** Evaluated per member before ranking; failing or unknown members are left out. */
  preFilter: conditionGroupSchema.optional(),
  weighting: z.literal('equal'),
});
export type Selection = z.infer<typeof selectionSchema>;

export const fireModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('allPassing') }),
  z.object({ mode: z.literal('bestByMetric'), metric: metricRefSchema }),
]);
export type FireMode = z.infer<typeof fireModeSchema>;

export const entryPhaseSchema = phaseSchema.extend({
  /** `fixed` when absent: the legs name their instruments, as in v1.1. */
  kind: z.enum(['fixed', 'selection']).optional(),
  selection: selectionSchema.optional(),
  fireMode: fireModeSchema.optional(),
});
export type EntryPhase = z.infer<typeof entryPhaseSchema>;

export const EXIT_RULE_KINDS = ['timeStop'] as const;
export const exitRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('timeStop'),
    id,
    /** Trading days held, counting the day the position opened. */
    barsHeld: z.number().int().min(1, 'Hold for at least 1 day').max(2520),
  }),
]);
export type ExitRule = z.infer<typeof exitRuleSchema>;

export const exitPhaseSchema = phaseSchema.extend({
  /** Rules combined with the Exit condition by OR: the first to trigger exits. */
  rules: z.array(exitRuleSchema).max(5).optional(),
});
export type ExitPhase = z.infer<typeof exitPhaseSchema>;

export const SCHEDULE_FREQUENCIES = [
  'daily',
  'weekly',
  'monthEnd',
  'quarterEnd',
  'yearEnd',
] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
/** When Entry and re-selection are evaluated; Exit rules run on every bar regardless. */
export const scheduleSchema = z.object({ frequency: z.enum(SCHEDULE_FREQUENCIES) });
export type Schedule = z.infer<typeof scheduleSchema>;

export const executionSchema = z.object({
  multiLegPolicy: z.enum(['concurrent', 'sequential', 'after_prior_fill']),
  /** Leg ids in submission order, for sequential policies. */
  legOrder: z.array(id).optional(),
  legTimeoutSec: z.number().int().min(1).max(86_400),
  onLegFailure: z.enum(['cancel_remaining', 'flatten_filled', 'leave_and_alert']),
  entryMilestone: z.enum(['full_fill', 'partial_fill']),
  reentry: z.object({
    mode: z.enum(['single_cycle', 'pyramid', 'independent_cycles']),
    cap: z.number().int().min(1).max(100).optional(),
  }),
  marketHoursPolicy: z.enum(['queue', 'cancel', 'extended_if_supported']),
  holidayCalendar: z.enum(['NYSE']),
  staleDataSec: z.number().int().min(1).max(86_400),
});
export type ExecutionPolicy = z.infer<typeof executionSchema>;

export const riskProfileSchema = z.object({
  maxOrderNotional: positiveDecimalString.optional(),
  maxStrategyExposure: positiveDecimalString.optional(),
  maxActiveOrders: z.number().int().min(1).max(1000).optional(),
  dailyLossLimit: positiveDecimalString.optional(),
  priceCollarPct: positiveDecimalString.optional(),
  /** Not yet part of the confirmed defaults; optional until decided. */
  maxOpenPositions: z.number().int().min(1).max(1000).optional(),
  maxDrawdownPct: positiveDecimalString.optional(),
});
export type RiskProfile = z.infer<typeof riskProfileSchema>;

/** Risk limits that must be set before activation (§6.10, decisions of 2026-10-04). */
export const REQUIRED_RISK_LIMITS = [
  'maxOrderNotional',
  'maxStrategyExposure',
  'maxActiveOrders',
  'dailyLossLimit',
  'priceCollarPct',
] as const satisfies readonly (keyof RiskProfile)[];

export const strategyDefinitionSchema = z.object({
  schemaVersion: z.literal(STRATEGY_SCHEMA_VERSION),
  entry: entryPhaseSchema,
  exit: exitPhaseSchema,
  execution: executionSchema,
  risk: riskProfileSchema,
  /** Absent means daily: every bar, as in v1.1. */
  schedule: scheduleSchema.optional(),
});
export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;
export type PhaseName = 'entry' | 'exit';
