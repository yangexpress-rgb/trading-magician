import { z } from 'zod';
import { STOCK_GROUP_IDS } from '../market/stock-groups';
import { BAR_INTERVALS, MARKET_FIELDS, PRICE_ADJUSTMENTS, SESSIONS } from './catalog';

/**
 * Strategy definition, schema version 3 (Design v1.0 §6, §13.2; proposal §4.5;
 * the Strategy Lab simplification, ADR 0049; What to trade, Entry, Exit,
 * ADR 0073).
 *
 * A definition is a validated tree, never display text. It is stored as one
 * JSON document per immutable strategy version. Structural rules live here;
 * rules that need outside context (instruments, accounts, feeds) live in
 * validate.ts. Older documents are migrated on read (migrate-v1.ts, migrate-v2.ts).
 */
export const STRATEGY_SCHEMA_VERSION = 5 as const;

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
/**
 * `off_peak_pct` (N217, ADR 0074): how far the latest close is off the best
 * close since Entry filled, in percent (below it for a long, above it for a
 * short). It is the trailing stop as an Exit when condition, read at the
 * Check Exit bar size like the stops (O144).
 */
/** `minutes_held` (N255): whole minutes since the cycle's earliest Entry fill, the intraday time stop. */
export const POSITION_FIELDS = [
  'entry_price',
  'gain_pct',
  'pnl',
  'quantity',
  'off_peak_pct',
  'days_held',
  'minutes_held',
  'atrs_below_entry',
  'expected_moves_1d',
  'expected_moves_5d',
] as const;
export type PositionField = (typeof POSITION_FIELDS)[number];
export interface PositionExpr {
  kind: 'position';
  id: NodeId;
  instrumentId: string;
  field: PositionField;
  /** `atrs_below_entry` only: the ATR period (N221); 20 when absent. */
  period?: number | undefined;
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
  /** Bars back from the current one, as on market values (absent is 0). */
  offset?: number | undefined;
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
  period: z.number().int().min(1).max(500).optional(),
  ...seriesSource,
});

export const metricExprSchema = z.object({
  kind: z.literal('metric'),
  id,
  metric: z.string().min(1).max(40),
  params: z.record(z.string(), z.union([z.number(), z.string().max(64)])),
  instrumentId: z.string().uuid({ message: 'Choose an instrument' }),
  offset: z.number().int().min(0).max(500).optional(),
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
  // A yes/no metric such as Earnings window needs nothing to compare with (N216).
  'is_true',
] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];
export const UNARY_OPERATORS: readonly ComparisonOperator[] = [
  'is_available',
  'is_stale',
  'is_true',
];
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
/**
 * `risk` (one risk quantity, ADR 0049): lose at most an amount if the stop is
 * hit. The amount is dollars or a % of equity; the distance to the stop is
 * the leg's stop price, or the Entry's risk distance (ATR × multiple).
 */
export const QUANTITY_TYPES = ['units', 'notional', 'pct_equity', 'risk'] as const;
export type QuantityType = (typeof QUANTITY_TYPES)[number];
export const RISK_AMOUNT_UNITS = ['dollars', 'pct_equity'] as const;
export const RISK_DISTANCES = ['stop_price', 'atr'] as const;
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

export const QUANTITY_ROUNDINGS = ['up', 'down', 'nearest'] as const;
export type QuantityRounding = (typeof QUANTITY_ROUNDINGS)[number];

export const plannedOrderSchema = z.object({
  id,
  legLabel: z.string().trim().min(1, 'Name this leg').max(40),
  instrumentId: z.string().uuid({ message: 'Choose an instrument' }),
  accountId: z.string().uuid({ message: 'Choose an account' }),
  side: z.enum(ORDER_SIDES),
  quantity: z.object({
    type: z.enum(QUANTITY_TYPES),
    value: positiveDecimalString,
    /**
     * How a fractional size becomes whole lots. `up` (the builder's default
     * since N273) rounds up, so a size below one unit buys one. Absent still
     * parses as `down`, so saved strategies keep sizing as before.
     */
    rounding: z.enum(QUANTITY_ROUNDINGS).default('down'),
    /** `risk` only: whether `value` is dollars or a % of equity. */
    amountIn: z.enum(RISK_AMOUNT_UNITS).optional(),
    /** `risk` only: the stop distance, from the leg's stop price or the Entry's risk distance. */
    distanceFrom: z.enum(RISK_DISTANCES).optional(),
  }),
  orderType: z.enum(ORDER_TYPES),
  limitPrice: exprSchema.optional(),
  stopPrice: exprSchema.optional(),
  timeInForce: z.enum(TIME_IN_FORCE).default('day'),
  timing: timingSchema.prefault({ mode: 'immediate' }),
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

/**
 * When a phase's condition fires (§6.5): the builder's one "Fire when"
 * control. `once_per_cycle` fires once per cycle: the Entry trigger re-arms
 * when a cycle closes. The cooldown counts evaluations (bars), not seconds.
 */
export const triggerSchema = z.object({
  mode: z.enum(TRIGGER_MODES).default('on_transition'),
  cooldownBars: z.number().int().min(0).max(1000).default(0),
  confirmationBars: z.number().int().min(0).max(100).default(0),
});
export type Trigger = z.infer<typeof triggerSchema>;
export const DEFAULT_TRIGGER: Trigger = {
  mode: 'on_transition',
  cooldownBars: 0,
  confirmationBars: 0,
};

/**
 * "Immediately" (N273): fires on every check the condition is true, with
 * nothing to confirm or wait for. The Fire when a new strategy, phase or
 * entry group starts with; the builder hides the other Fire when fields.
 */
export const IMMEDIATE_TRIGGER: Trigger = {
  mode: 'while_true',
  cooldownBars: 0,
  confirmationBars: 0,
};

/** Whether a Fire when is "Immediately": any check the condition holds fires. */
export const isImmediateTrigger = (t: Trigger | undefined): boolean =>
  !t || (t.mode === 'while_true' && t.confirmationBars === 0 && t.cooldownBars === 0);

export const phaseSchema = z.object({
  condition: conditionGroupSchema,
  trigger: triggerSchema.prefault({}),
  orders: z.array(plannedOrderSchema).max(20),
});
export type Phase = z.infer<typeof phaseSchema>;

// ---------------------------------------------------------------------------
// v1.2: Selection groups, per-leg fire mode, exit rules and the schedule.
// Every field is optional and absent on v1.1 definitions, so they parse,
// hash and run exactly as before (design principle 5).
// ---------------------------------------------------------------------------

/**
 * The schedules before N227, as saved: bar cadences (every 1-minute, 5-minute
 * or hourly bar), once a day after the close, and calendar periods, with
 * `at` for a check after the open (N226). Still read; converted by
 * `scheduleFrom` when parsed.
 */
export const SCHEDULE_FREQUENCIES = [
  'bar1m',
  'bar5m',
  'bar1h',
  'daily',
  'weekly',
  'monthEnd',
  'quarterEnd',
  'yearEnd',
] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];
export const SCHEDULE_TIMES = ['close', 'open1m', 'open5m', 'open1h'] as const;
export type ScheduleTime = (typeof SCHEDULE_TIMES)[number];

/**
 * When a part is checked (N227, ADR 0078), in three choices: which bar, its
 * size, and on which days. `entry.schedule` gates Entry and a group's filter
 * and ranking; `exit.schedule` gates Exit (ADR 0073).
 *
 * - which: every bar of that size, the 1st or 2nd of the session, the last
 *   (ending at the close), or before the open.
 * - bar: 1-minute, 5-minute, 30-minute, hourly or daily. Every 1-day bar is
 *   once a day after the close.
 * - days: every trading day, or the last trading day of each week, month,
 *   quarter or year.
 */
export const SCHEDULE_WHICH = ['every', 'first', 'second', 'last', 'beforeOpen'] as const;
export type ScheduleWhich = (typeof SCHEDULE_WHICH)[number];
export const SCHEDULE_BARS = ['1m', '5m', '30m', '1h', '1d'] as const;
export type ScheduleBar = (typeof SCHEDULE_BARS)[number];
export const SCHEDULE_DAYS = ['daily', 'weekly', 'monthEnd', 'quarterEnd', 'yearEnd'] as const;
export type ScheduleDays = (typeof SCHEDULE_DAYS)[number];

export interface Schedule {
  which: ScheduleWhich;
  bar: ScheduleBar;
  days: ScheduleDays;
}

/** A schedule saved before N227 (`{ frequency, at }`) in the three choices; same checks. */
export function scheduleFrom(frequency: ScheduleFrequency, at?: ScheduleTime): Schedule {
  switch (frequency) {
    case 'bar1m':
      return { which: 'every', bar: '1m', days: 'daily' };
    case 'bar5m':
      return { which: 'every', bar: '5m', days: 'daily' };
    case 'bar1h':
      return { which: 'every', bar: '1h', days: 'daily' };
    default:
      if (at === 'open1m') return { which: 'first', bar: '1m', days: frequency };
      if (at === 'open5m') return { which: 'first', bar: '5m', days: frequency };
      if (at === 'open1h') return { which: 'first', bar: '1h', days: frequency };
      return { which: 'every', bar: '1d', days: frequency };
  }
}

const newScheduleSchema = z.object({
  which: z.enum(SCHEDULE_WHICH),
  bar: z.enum(SCHEDULE_BARS),
  days: z.enum(SCHEDULE_DAYS),
});
const legacyScheduleSchema = z.object({
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  at: z.enum(SCHEDULE_TIMES).optional(),
});

/** Reads both shapes; saved strategies are not rewritten, so their hashes stay. */
export const scheduleSchema: z.ZodType<Schedule> = z.union([
  newScheduleSchema,
  legacyScheduleSchema.transform((s) => scheduleFrom(s.frequency, s.at)),
]);

/** A metric from the registry with its parameters (see metrics.ts). */
export const metricRefSchema = z.object({
  metric: z.string().min(1).max(40),
  params: z.record(z.string(), z.union([z.number(), z.string().max(64)])).default({}),
});
export type MetricRef = z.infer<typeof metricRefSchema>;

/** The built-in stock groups (ADR 0080): S&P 500, Nasdaq 100, Dow 30, … and the S&P 500 sectors. */
export const BUILTIN_UNIVERSES = STOCK_GROUP_IDS;
export type BuiltinUniverse = (typeof BUILTIN_UNIVERSES)[number];

/** A group's members (ADR 0073): a built-in universe or the person's own list. */
export const groupUniverseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('builtin'), id: z.enum(BUILTIN_UNIVERSES) }),
  z.object({
    type: z.literal('list'),
    instrumentIds: z
      .array(z.string().uuid({ message: 'Choose an instrument' }))
      .min(1, 'Add at least one instrument to the list')
      .max(600),
  }),
]);
export type GroupUniverse = z.infer<typeof groupUniverseSchema>;

export const selectionCountSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fixed'), value: z.number().int().min(1).max(600) }),
  z.object({ type: z.literal('percent'), value: z.number().gt(0).max(100) }),
]);
export type SelectionCount = z.infer<typeof selectionCountSchema>;

/** Rank by a metric, highest or lowest first, and keep the top N or N%. */
export const groupRankingSchema = metricRefSchema.extend({
  /** Highest value first, or lowest first (cheapest by P/E style). */
  direction: z.enum(['desc', 'asc']),
  count: selectionCountSchema,
});
export type GroupRanking = z.infer<typeof groupRankingSchema>;

/**
 * What to trade (ADR 0073), the first part of every strategy.
 *
 * - `assets`: specific instruments, the ones the Entry legs trade (so they
 *   can never disagree). One is the usual case; several are entered and
 *   exited together as one position. The builder picks them in What to trade
 *   and writes them to the legs.
 * - `group`: a universe, an optional filter each member must pass, then an
 *   optional ranking. Each candidate is traded on its own by the one Entry
 *   leg ("each pick"). Without a ranking every member that passes is a
 *   candidate, up to the risk limit on instruments held.
 */
export const tradeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assets') }),
  z.object({
    kind: z.literal('group'),
    universe: groupUniverseSchema,
    /** Evaluated per member before ranking; failing or unknown members are left out. */
    filter: conditionGroupSchema.optional(),
    ranking: groupRankingSchema.optional(),
    /**
     * The Entry leg's amount is the total, split equally over the N picks
     * (schema 2's form, kept for converted strategies). Absent: per pick.
     */
    splitTotal: z.boolean().optional(),
  }),
]);
export type Trade = z.infer<typeof tradeSchema>;
export type GroupTrade = Extract<Trade, { kind: 'group' }>;

/**
 * Schema 2's "Selection group of these legs" (ADR 0049 D3), kept as saved
 * (ADR 0073): the Entry legs are ranked by the metric and the top N
 * qualifying legs fire, each with its own quantity. The builder no longer
 * offers it.
 */
export const rankedLegsSchema = groupRankingSchema.extend({
  preFilter: conditionGroupSchema.optional(),
});
export type RankedLegs = z.infer<typeof rankedLegsSchema>;

export const POSITION_DIRECTIONS = ['long', 'short'] as const;
export type PositionDirection = (typeof POSITION_DIRECTIONS)[number];

/**
 * One risk distance per Entry (ADR 0049): the stop is `atrMultiple` ×
 * ATR(`atrPeriod`) of daily bars from the entry price. Risk-sized legs that
 * size from the ATR read it, and so does the ATR stop unless it overrides it,
 * so sizing and the stop can't drift apart.
 */
export const riskDistanceSchema = z.object({
  atrPeriod: z.number().int().min(1).max(500),
  atrMultiple: positiveDecimalString,
});
export type RiskDistance = z.infer<typeof riskDistanceSchema>;

export const entryPhaseSchema = phaseSchema.extend({
  /** When Entry (and a group's filter and ranking) is checked; absent: `defaultSchedule`. */
  schedule: scheduleSchema.optional(),
  risk: riskDistanceSchema.optional(),
  /** Kept as saved (ADR 0073): schema 2's ranked legs. */
  rankedLegs: rankedLegsSchema.optional(),
});
export type EntryPhase = z.infer<typeof entryPhaseSchema>;

export const EXIT_RULE_KINDS = [
  'timeStop',
  'atrStop',
  'expectedMove',
  'trailingStop',
  'leftGroup',
] as const;
export const EXPECTED_MOVE_SIDES = ['either', 'gain', 'loss'] as const;
export const exitRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('timeStop'),
    id,
    /** Trading days held, counting the day the position opened. */
    barsHeld: z.number().int().min(1, 'Hold for at least 1 day').max(2520),
  }),
  /**
   * v1.2 item 9: exit when a daily close crosses the entry price minus (long)
   * or plus (short) the stop distance as measured at entry: the Entry's risk
   * distance, or `override` when the person set one of its own (ADR 0049).
   * The level is fixed at entry; a trailing stop is not part of this round.
   */
  z.object({
    kind: z.literal('atrStop'),
    id,
    override: riskDistanceSchema.optional(),
  }),
  /**
   * Options brief v2 §10 item 10 (ADR 0053): exit when a daily close has moved
   * from the entry price by more than `multiple` × the expected move recorded
   * when Entry was decided (the options signal over `horizon` days). The move
   * is fixed at entry; `side` limits it to a gain or a loss.
   */
  z.object({
    kind: z.literal('expectedMove'),
    id,
    horizon: z.union([z.literal(1), z.literal(5)]),
    multiple: positiveDecimalString,
    side: z.enum(EXPECTED_MOVE_SIDES),
  }),
  /**
   * ADR 0059: exit when a daily close is more than `percent` % below the
   * highest close since Entry filled (above the lowest, for a short). The
   * peak starts at the entry price and only moves in the position's favour.
   */
  z.object({
    kind: z.literal('trailingStop'),
    id,
    percent: positiveDecimalString.refine((v) => Number(v) < 100, 'Use less than 100%'),
  }),
  /**
   * ADR 0073, groups only: at each Entry check, sell a holding that no longer
   * passes the filter or the ranking (schema 2's rebalance exit; its absence
   * is schema 2's `keepHoldings`).
   */
  z.object({ kind: z.literal('leftGroup'), id }),
]);
export type ExitRule = z.infer<typeof exitRuleSchema>;

export const exitPhaseSchema = phaseSchema.extend({
  /**
   * Absent with a Selection group or per-leg conditions: there the Exit
   * condition is checked directly on every bar, with no trigger (ADR 0049).
   */
  trigger: triggerSchema.optional(),
  /** "Mirror Entry legs" (ADR 0049): the Exit legs are generated from the Entry legs. */
  mirrorEntry: z.boolean().optional(),
  /** Rules combined with the Exit condition by OR: the first to trigger exits. */
  rules: z.array(exitRuleSchema).max(6).optional(),
  /**
   * When the Exit condition and the exit rules are checked (ADR 0073). Absent:
   * on every bar the run steps on, as schema 2 did.
   */
  schedule: scheduleSchema.optional(),
});
export type ExitPhase = z.infer<typeof exitPhaseSchema>;

/**
 * v1.2 item 8: another entry group, with its own direction, Entry and Exit.
 * The strategy's own Entry and Exit are the first group; these follow it.
 * Exits belong to their group, as the strategy's Exit belongs to its Entry.
 */
export const entryGroupSchema = z.object({
  id,
  label: z.string().trim().min(1, 'Name this group').max(40),
  entry: entryPhaseSchema,
  exit: exitPhaseSchema,
});
export type EntryGroup = z.infer<typeof entryGroupSchema>;

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
  /**
   * "Allow timed entries without conditions" (ADR 0049): legs with an exact or
   * relative timing go at their time alone, without the phase condition, and
   * an exact-timed Entry leg can open a cycle by itself (§6.8).
   */
  timingOnly: z.boolean().optional(),
  /**
   * "Flatten at session end" (N256): at the last bar of each regular session,
   * after Exit when, anything still held closes at that bar's close with exit
   * reason "Session end". Needs intraday bars; absent is off.
   */
  flattenAtSessionEnd: z.boolean().optional(),
});
export type ExecutionPolicy = z.infer<typeof executionSchema>;

export const riskProfileSchema = z.object({
  maxOrderNotional: positiveDecimalString.optional(),
  maxStrategyExposure: positiveDecimalString.optional(),
  maxActiveOrders: z.number().int().min(1).max(1000).optional(),
  dailyLossLimit: positiveDecimalString.optional(),
  priceCollarPct: positiveDecimalString.optional(),
  /** How many instruments may be held at once (not orders: see maxActiveOrders). */
  maxInstrumentsHeld: z.number().int().min(1).max(1000).optional(),
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
  /** What to trade (ADR 0073). */
  trade: tradeSchema,
  entry: entryPhaseSchema,
  exit: exitPhaseSchema,
  execution: executionSchema,
  risk: riskProfileSchema,
  /** More entry groups after the strategy's own Entry and Exit (v1.2 item 8). */
  groups: z.array(entryGroupSchema).max(3).optional(),
});
export type StrategyDefinition = z.infer<typeof strategyDefinitionSchema>;
export type PhaseName = 'entry' | 'exit';
export type ExitTrigger = ExitPhase['trigger'];
