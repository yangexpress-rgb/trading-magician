import { z } from 'zod';
import { randomId, type IdFactory } from './ids';
import { DEFAULT_EXECUTION } from './defaults';
import {
  COMPARISON_OPERATORS,
  RANGE_OPERATORS,
  UNARY_OPERATORS,
  decimalString,
  exprSchema,
  positiveDecimalString,
  type ComparisonOperator,
  type Expr,
  type NodeId,
} from './schema';

/**
 * The state-machine definition form (state-machine brief v1.3 §2, ADR 0124
 * P2a). A separate top-level form beside the rules form (`StrategyDefinition`):
 * it has `trade` (the signal context), `machine` (states and ordered rows),
 * `execution` and `risk`, and no Entry or Exit. Only the places that parse,
 * store and list definitions see both forms (`parseAnyDefinition`); every
 * reader of Entry and Exit keeps seeing rules-form documents only.
 *
 * A state-machine document has its own version, `machineVersion`, and never
 * passes through the rules form's migrations (§2.5).
 */
export const MACHINE_FORM = 'state_machine' as const;
export const MACHINE_SCHEMA_VERSION = 1 as const;

const id = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
// The state operands (§2.1): only in state rules, never in statistics, never
// with an offset. They are their own kinds, outside `Expr`, so no rules-form
// condition can hold one and no statistic or calculation can take one.
// ---------------------------------------------------------------------------

/** Days the run has held its current state, the entry day counting as day 1. */
export interface DaysInStateExpr {
  kind: 'days_in_state';
  id: NodeId;
}
/**
 * Days the run has spent in any of these states, entry into the set counting
 * as day 1, not restarting on moves within the set, 0 when the current state
 * is outside it (§2.1).
 */
export interface DaysInStatesExpr {
  kind: 'days_in_states';
  id: NodeId;
  stateIds: string[];
}
export type StateDaysExpr = DaysInStateExpr | DaysInStatesExpr;
/** What one side of a state-rule comparison may be. */
export type MachineExpr = Expr | StateDaysExpr;

export interface MachineComparison {
  kind: 'comparison';
  id: NodeId;
  left: MachineExpr;
  operator: ComparisonOperator;
  right?: MachineExpr | undefined;
  upper?: MachineExpr | undefined;
}
/** The current or prior state is one of these (§2.1 `state_is`). */
export interface StateIsCondition {
  kind: 'state_is';
  id: NodeId;
  which: 'current' | 'prior';
  stateIds: string[];
}
/** Another row's rule, by reference, never copied (§2.1). */
export interface RowRefCondition {
  kind: 'row_ref';
  id: NodeId;
  rowId: string;
}
export interface MachineGroup {
  kind: 'group';
  id: NodeId;
  op: 'and' | 'or';
  negate: boolean;
  children: MachineCondition[];
}
export type MachineCondition =
  MachineGroup | MachineComparison | StateIsCondition | RowRefCondition;

const stateIds = z.array(id).min(1, 'Choose at least one state').max(20);

// Strict: an offset (or any other key) is refused, not dropped (§2.1).
export const daysInStateExprSchema = z.object({ kind: z.literal('days_in_state'), id }).strict();
export const daysInStatesExprSchema = z
  .object({
    kind: z.literal('days_in_states'),
    id,
    stateIds,
  })
  .strict();
export const machineExprSchema: z.ZodType<MachineExpr> = z.union([
  daysInStateExprSchema,
  daysInStatesExprSchema,
  exprSchema,
]);

export const machineComparisonSchema = z
  .object({
    kind: z.literal('comparison'),
    id,
    left: machineExprSchema,
    operator: z.enum(COMPARISON_OPERATORS),
    right: machineExprSchema.optional(),
    upper: machineExprSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if (!UNARY_OPERATORS.includes(c.operator) && !c.right)
      ctx.addIssue({ code: 'custom', path: ['right'], message: 'Add a value to compare with' });
    if (RANGE_OPERATORS.includes(c.operator) && !c.upper)
      ctx.addIssue({ code: 'custom', path: ['upper'], message: 'Add an upper bound' });
  });

export const stateIsConditionSchema = z.object({
  kind: z.literal('state_is'),
  id,
  which: z.enum(['current', 'prior']),
  stateIds,
});
export const rowRefConditionSchema = z.object({ kind: z.literal('row_ref'), id, rowId: id });

export const machineGroupSchema: z.ZodType<MachineGroup> = z.object({
  kind: z.literal('group'),
  id,
  op: z.enum(['and', 'or']),
  negate: z.boolean().default(false),
  get children(): z.ZodArray<z.ZodType<MachineCondition>> {
    return z.array(machineConditionSchema);
  },
}) as z.ZodType<MachineGroup>;

export const machineConditionSchema: z.ZodType<MachineCondition> = z.union([
  machineGroupSchema,
  machineComparisonSchema,
  stateIsConditionSchema,
  rowRefConditionSchema,
]);

// ---------------------------------------------------------------------------
// States and rows (§2)
// ---------------------------------------------------------------------------

const weightPct = decimalString.refine(
  (v) => Number(v) >= 0 && Number(v) <= 100,
  'A weight is between 0% and 100%',
);

export const targetSchema = z.object({
  instrumentId: z.string().uuid({ message: 'Choose an instrument' }),
  /** Long-only, % of equity (§2). */
  weightPct,
});
export type Target = z.infer<typeof targetSchema>;

export const machineStateSchema = z
  .object({
    id,
    name: z.string().trim().min(1, 'Name this state').max(40),
    /** Empty: 100% cash. The weights' remainder is cash. */
    targets: z.array(targetSchema).max(10),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.targets.forEach((t, i) => {
      if (seen.has(t.instrumentId))
        ctx.addIssue({
          code: 'custom',
          path: ['targets', i, 'instrumentId'],
          message: 'This instrument is already in the state',
        });
      seen.add(t.instrumentId);
    });
    // Weights are decimals with at most 10 places, so cents of a percent add exactly.
    const total = s.targets.reduce((n, t) => n + Math.round(Number(t.weightPct) * 1e10), 0);
    if (total > 100 * 1e10)
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'The weights add up to more than 100%',
      });
  });
export type MachineState = z.infer<typeof machineStateSchema>;

export const rowOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('go'), stateId: id }),
  z.object({ kind: z.literal('stay') }),
]);
export type RowOutcome = z.infer<typeof rowOutcomeSchema>;

export const machineRowSchema = z.object({
  id,
  label: z.string().trim().max(60).optional(),
  /** Absent or an empty group: always true. Only the last row may be unconditional. */
  condition: machineGroupSchema.optional(),
  outcome: rowOutcomeSchema,
});
export type MachineRow = z.infer<typeof machineRowSchema>;

export const machineSchema = z.object({
  states: z.array(machineStateSchema).min(2, 'Add at least two states').max(20),
  /** Tested from the top at each daily close; the first true row decides the day. */
  rows: z.array(machineRowSchema).min(1, 'Add at least one row').max(50),
});
export type Machine = z.infer<typeof machineSchema>;

/** The instruments the rows read (§2.5 signal context). */
export const machineTradeSchema = z.object({
  kind: z.literal('signals'),
  instrumentIds: z.array(z.string().uuid({ message: 'Choose an instrument' })).max(10),
});

/** Sells go first and buys after they fill (`after_prior_fill`), so no policy is chosen. */
export const machineExecutionSchema = z.object({
  legTimeoutSec: z.number().int().min(1).max(86_400),
  onLegFailure: z.enum(['cancel_remaining', 'flatten_filled', 'leave_and_alert']),
  marketHoursPolicy: z.enum(['queue', 'cancel', 'extended_if_supported']),
  holidayCalendar: z.enum(['NYSE']),
  staleDataSec: z.number().int().min(1).max(86_400),
});
export type MachineExecution = z.infer<typeof machineExecutionSchema>;

const pctOfEquity = positiveDecimalString.refine((v) => Number(v) <= 100, 'At most 100%');

/**
 * This form's own risk treatment (§2.8): notional limits as % of equity, no
 * strategy trailing stop (refused, not ignored).
 */
export const machineRiskSchema = z
  .object({
    maxOrderPctEquity: pctOfEquity.optional(),
    maxStrategyPctEquity: pctOfEquity.optional(),
    maxActiveOrders: z.number().int().min(1).max(1000).optional(),
    dailyLossLimit: positiveDecimalString.optional(),
    priceCollarPct: positiveDecimalString.optional(),
    maxDrawdownPct: positiveDecimalString.optional(),
  })
  .strict();
export type MachineRisk = z.infer<typeof machineRiskSchema>;

export const machineDefinitionSchema = z.object({
  form: z.literal(MACHINE_FORM),
  machineVersion: z.literal(MACHINE_SCHEMA_VERSION),
  trade: machineTradeSchema,
  machine: machineSchema,
  execution: machineExecutionSchema,
  risk: machineRiskSchema,
});
export type MachineDefinition = z.infer<typeof machineDefinitionSchema>;

/** §2.8 defaults: 100% of equity per order and per strategy; the usual collar and order count. */
export const DEFAULT_MACHINE_RISK: MachineRisk = {
  maxOrderPctEquity: '100',
  maxStrategyPctEquity: '100',
  maxActiveOrders: 10,
  priceCollarPct: '5',
};

export const DEFAULT_MACHINE_EXECUTION: MachineExecution = {
  legTimeoutSec: DEFAULT_EXECUTION.legTimeoutSec,
  onLegFailure: DEFAULT_EXECUTION.onLegFailure,
  marketHoursPolicy: DEFAULT_EXECUTION.marketHoursPolicy,
  holidayCalendar: DEFAULT_EXECUTION.holidayCalendar,
  staleDataSec: DEFAULT_EXECUTION.staleDataSec,
};

/** A new state machine: cash and one other state, the fallback row going to cash. */
export function createMachineDefinition(ids: IdFactory = randomId): MachineDefinition {
  const cash = ids();
  return {
    form: MACHINE_FORM,
    machineVersion: MACHINE_SCHEMA_VERSION,
    trade: { kind: 'signals', instrumentIds: [] },
    machine: {
      states: [
        { id: ids(), name: 'Invested', targets: [] },
        { id: cash, name: 'Cash', targets: [] },
      ],
      rows: [{ id: ids(), outcome: { kind: 'go', stateId: cash } }],
    },
    execution: { ...DEFAULT_MACHINE_EXECUTION },
    risk: { ...DEFAULT_MACHINE_RISK },
  };
}

export const isUnconditional = (row: Pick<MachineRow, 'condition'>): boolean =>
  !row.condition || row.condition.children.length === 0;

/** The state the run starts in (§2.7): the one the unconditional last row names. */
export function fallbackStateId(machine: Machine): string | undefined {
  const last = machine.rows[machine.rows.length - 1];
  return last && isUnconditional(last) && last.outcome.kind === 'go'
    ? last.outcome.stateId
    : undefined;
}

export function* walkMachineConditions(node: MachineCondition): Generator<MachineCondition> {
  yield node;
  if (node.kind === 'group') for (const c of node.children) yield* walkMachineConditions(c);
}

export const isStateDays = (e: MachineExpr | undefined): e is StateDaysExpr =>
  e?.kind === 'days_in_state' || e?.kind === 'days_in_states';
