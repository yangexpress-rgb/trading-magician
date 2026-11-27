import Decimal from 'decimal.js';
import { CONTEXT_INSTRUMENT_ID } from './evaluate';
import {
  fallbackStateId,
  isStateDays,
  isUnconditional,
  walkMachineConditions,
  type MachineComparison,
  type MachineCondition,
  type MachineDefinition,
  type MachineGroup,
} from './machine-schema';
import { getMetric, isSessionMetric } from './metrics';
import type { Comparison, Expr } from './schema';
import { walkExpr } from './tree';
import {
  LIMITS,
  checkRuleComparison,
  checkRuleExpr,
  type Severity,
  type ValidationContext,
  type ValidationIssue,
  type ValidationResult,
} from './validate';

/**
 * Checks of a state-machine definition (state-machine brief v1.3 §2, ADR 0124
 * P2a) beyond its schema: states and rows that refer to each other, the state
 * operands' restrictions, daily bars only, and the target instruments. Row
 * conditions get the rules form's own comparison and value checks.
 */

/** Instrument classes a target may hold: long-only stocks and ETFs (§2). */
const TARGET_CLASSES = new Set(['stock', 'etf']);

type Add = (
  severity: Severity,
  code: string,
  message: string,
  path: (string | number)[],
  nodeId?: string,
) => void;

export function validateMachine(def: MachineDefinition, ctx: ValidationContext): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add: Add = (severity, code, message, path, nodeId) =>
    issues.push({ severity, code, message, path, ...(nodeId ? { nodeId } : {}) });

  checkIds(def, add);
  checkStates(def, ctx, add);
  checkRows(def, ctx, add);
  checkRisk(def, add);

  return {
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
  };
}

function checkIds(def: MachineDefinition, add: Add) {
  const seen = new Set<string>();
  const once = (id: string, path: (string | number)[]) => {
    if (seen.has(id)) add('error', 'duplicate_id', `The id "${id}" is used twice`, path, id);
    seen.add(id);
  };
  def.machine.states.forEach((s, i) => once(s.id, ['machine', 'states', i, 'id']));
  def.machine.rows.forEach((r, i) => {
    once(r.id, ['machine', 'rows', i, 'id']);
    if (r.condition)
      for (const n of walkMachineConditions(r.condition)) {
        once(n.id, ['machine', 'rows', i, 'condition']);
        if (n.kind === 'comparison')
          for (const side of [n.left, n.right, n.upper])
            if (side && !isStateDays(side))
              for (const e of walkExpr(side)) once(e.id, ['machine', 'rows', i, 'condition']);
      }
  });
  const names = new Map<string, number>();
  def.machine.states.forEach((s, i) => {
    const key = s.name.trim().toLowerCase();
    if (names.has(key))
      add('error', 'duplicate_state_name', `Two states are named "${s.name}"`, [
        'machine',
        'states',
        i,
        'name',
      ]);
    names.set(key, i);
  });
}

function checkStates(def: MachineDefinition, ctx: ValidationContext, add: Add) {
  const named = new Set(
    def.machine.rows.flatMap((r) => (r.outcome.kind === 'go' ? [r.outcome.stateId] : [])),
  );
  def.machine.states.forEach((s, i) => {
    s.targets.forEach((t, j) => {
      const path = ['machine', 'states', i, 'targets', j, 'instrumentId'];
      const info = ctx.instruments.get(t.instrumentId);
      if (!info) add('error', 'unknown_instrument', 'This instrument is not available', path, s.id);
      else if (!TARGET_CLASSES.has(info.assetClass))
        add(
          'error',
          'target_not_tradable',
          `${info.symbol} can't be a target: a state holds stocks and ETFs`,
          path,
          s.id,
        );
      else if (!ctx.hasFeed(info.assetClass, 'bars'))
        add('error', 'no_feed', `No price feed covers ${info.symbol}`, path, s.id);
    });
    if (!named.has(s.id))
      add(
        'warning',
        'state_unreachable',
        `No row goes to "${s.name}", so the run never enters it`,
        ['machine', 'states', i],
        s.id,
      );
  });
}

function checkRows(def: MachineDefinition, ctx: ValidationContext, add: Add) {
  const { rows, states } = def.machine;
  const stateIds = new Set(states.map((s) => s.id));
  const rowIds = new Map(rows.map((r, i) => [r.id, i]));
  const signals = new Set(def.trade.instrumentIds);
  if (signals.size === 0)
    add('error', 'no_signal', 'Choose the instrument the rules read', ['trade', 'instrumentIds']);

  if (!fallbackStateId(def.machine))
    add(
      'error',
      'no_fallback',
      'The last row must have no rule and go to a state: the run starts there and goes there when no other row is true',
      ['machine', 'rows', rows.length - 1],
      rows[rows.length - 1]?.id,
    );

  rows.forEach((row, i) => {
    const path = ['machine', 'rows', i];
    const last = i === rows.length - 1;
    if (row.outcome.kind === 'go' && !stateIds.has(row.outcome.stateId))
      add(
        'error',
        'unknown_state',
        'This row goes to a state that does not exist',
        [...path, 'outcome'],
        row.id,
      );
    if (isUnconditional(row) && !last)
      add(
        'error',
        'unconditional_row_not_last',
        'Only the last row may have no rule: rows below this one could never be reached',
        [...path, 'condition'],
        row.id,
      );
    if (row.condition)
      checkRowCondition(row.condition, [...path, 'condition'], ctx, add, {
        stateIds,
        rowIds,
        signals,
      });
  });

  // Row references may not loop (a row reusing a row that reuses it).
  const refs = new Map(
    rows.map((r) => [
      r.id,
      r.condition
        ? [...walkMachineConditions(r.condition)].flatMap((n) =>
            n.kind === 'row_ref' ? [n.rowId] : [],
          )
        : [],
    ]),
  );
  const state = new Map<string, 'open' | 'done'>();
  const loops = new Set<string>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      for (const r of trail.slice(trail.indexOf(id))) loops.add(r);
      return;
    }
    state.set(id, 'open');
    for (const next of refs.get(id) ?? []) if (rowIds.has(next)) visit(next, [...trail, id]);
    state.set(id, 'done');
  };
  for (const r of rows) visit(r.id, []);
  for (const id of loops)
    add(
      'error',
      'row_ref_loop',
      'This row reuses a rule that, through other rows, reuses this row: remove one reference',
      ['machine', 'rows', rowIds.get(id) ?? 0, 'condition'],
      id,
    );
}

interface RowScope {
  stateIds: ReadonlySet<string>;
  rowIds: ReadonlyMap<string, number>;
  signals: ReadonlySet<string>;
}

function checkRowCondition(
  root: MachineGroup,
  rootPath: (string | number)[],
  ctx: ValidationContext,
  add: Add,
  scope: RowScope,
) {
  let comparisons = 0;
  const depth = (n: MachineCondition): number =>
    n.kind === 'group' ? 1 + Math.max(0, ...n.children.map(depth)) : 1;
  if (depth(root) > LIMITS.maxConditionDepth)
    add(
      'error',
      'condition_too_deep',
      `Groups are nested more than ${LIMITS.maxConditionDepth} levels deep`,
      rootPath,
      root.id,
    );

  const visit = (n: MachineCondition, path: (string | number)[]) => {
    switch (n.kind) {
      case 'group':
        if (n !== root && n.children.length === 0)
          add(
            'error',
            'empty_group',
            'This group is empty; add a condition or remove it',
            path,
            n.id,
          );
        n.children.forEach((c, i) => visit(c, [...path, 'children', i]));
        return;
      case 'state_is':
        for (const s of n.stateIds)
          if (!scope.stateIds.has(s))
            add(
              'error',
              'unknown_state',
              'This condition names a state that does not exist',
              path,
              n.id,
            );
        return;
      case 'row_ref':
        if (!scope.rowIds.has(n.rowId))
          add(
            'error',
            'unknown_row',
            'This condition reuses a row that does not exist',
            path,
            n.id,
          );
        return;
      case 'comparison':
        comparisons++;
        checkComparison(n, path, ctx, add, scope);
        return;
    }
  };
  visit(root, rootPath);
  if (comparisons > LIMITS.maxComparisonsPerPhase)
    add(
      'error',
      'too_many_conditions',
      `This row has more than ${LIMITS.maxComparisonsPerPhase} conditions`,
      rootPath,
      root.id,
    );
}

function checkComparison(
  c: MachineComparison,
  path: (string | number)[],
  ctx: ValidationContext,
  add: Add,
  scope: RowScope,
) {
  const sides = [
    [c.left, 'left'],
    [c.right, 'right'],
    [c.upper, 'upper'],
  ] as const;
  const days = sides.filter(([e]) => isStateDays(e));
  if (days.length === 0) checkRuleComparison(c as Comparison, path, ctx, add);
  else {
    for (const [e, key] of sides) {
      if (!e) continue;
      if (e.kind === 'days_in_states')
        for (const s of e.stateIds)
          if (!scope.stateIds.has(s))
            add(
              'error',
              'unknown_state',
              'This count names a state that does not exist',
              [...path, key],
              e.id,
            );
      if (!isStateDays(e)) checkRuleExpr(e, [...path, key], ctx, add);
    }
    // The run keeps no history of the counts, so nothing may read them bars ago (§2.1).
    if (c.operator === 'crosses_above' || c.operator === 'crosses_below')
      add(
        'error',
        'state_days_history',
        'Days in state has no history to cross; use "is at least" or "is below" instead',
        path,
        c.id,
      );
    if (c.operator === 'is_available' || c.operator === 'is_stale' || c.operator === 'is_true')
      add(
        'error',
        'state_days_operator',
        'Days in state is always known: compare it with a number',
        path,
        c.id,
      );
  }

  // Daily bars only in v1 (§2), no positions (a state machine has no cycle), and
  // only the signal instruments (§2.5).
  for (const [e, key] of sides) {
    if (!e || isStateDays(e)) continue;
    for (const x of walkExpr(e as Expr)) {
      const at = [...path, key];
      if (x.kind === 'position')
        add(
          'error',
          'position_in_machine',
          'A state machine has no position values: use the state and days in it instead',
          at,
          x.id,
        );
      if ((x.kind === 'market' || x.kind === 'indicator') && x.interval !== '1d')
        add('error', 'machine_daily_only', 'State rules read daily bars only', at, x.id);
      if (x.kind === 'metric' && isSessionMetric(x.metric))
        add(
          'error',
          'machine_daily_only',
          `${getMetric(x.metric)?.label ?? x.metric} reads today's intraday bars; state rules read daily bars only`,
          at,
          x.id,
        );
      if ('instrumentId' in x) {
        if (x.instrumentId === CONTEXT_INSTRUMENT_ID) continue; // reported by the rule checks
        if (!scope.signals.has(x.instrumentId))
          add(
            'error',
            'signal_not_listed',
            `${ctx.instruments.get(x.instrumentId)?.symbol ?? 'This instrument'} isn't one of the instruments the rules read: add it there`,
            at,
            x.id,
          );
      }
    }
  }
}

function checkRisk(def: MachineDefinition, add: Add) {
  const largest = def.machine.states.reduce(
    (m, s) => Decimal.max(m, ...s.targets.map((t) => new Decimal(t.weightPct))),
    new Decimal(0),
  );
  for (const key of ['maxOrderPctEquity', 'maxStrategyPctEquity'] as const) {
    const v = def.risk[key];
    if (v && new Decimal(v).lt(largest))
      add(
        'warning',
        'limit_below_target',
        `This limit (${v}% of equity) is below the largest target (${largest.toString()}%), so rebalances to that state are refused`,
        ['risk', key],
      );
  }
}
