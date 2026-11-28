'use client';

import {
  COMPARISON_OPERATORS,
  duplicateNode,
  insertNode,
  isYesNoExpr,
  moveNode,
  randomId,
  RANGE_OPERATORS,
  removeNode,
  replaceNode,
  UNARY_OPERATORS,
  type Comparison,
  type ComparisonOperator,
  type ConditionGroup,
  type ConditionNode,
} from '@tm/domain';
import { cx } from '@tm/ui';
import { createContext, useContext } from 'react';
import { describeCondition, describeMachineCondition, OPERATOR_LABELS } from '@/lib/strategy-text';
import { defaultInstrumentOf, useEditor } from './editor-context';
import { ExpressionEditor, newExpr } from './expression-editor';
import { MiniSelect, RowButton } from './fields';

type Path = readonly (string | number)[];

/**
 * A state rule (ADR 0124 P3b, brief v1.4 §2.1): the same tree editor, plus
 * "the current or prior state is", "same rule as row N", and days in a state
 * as a comparison's left side. Absent for the rules form.
 */
export interface MachineRuleScope {
  states: readonly { id: string; name: string }[];
  /** Other rows this rule may reuse, in order, with their numbers. */
  rows: readonly { id: string; number: number; label?: string | undefined }[];
}

const MachineScope = createContext<MachineRuleScope | null>(null);

type StateIsNode = { kind: 'state_is'; id: string; which: 'current' | 'prior'; stateIds: string[] };
type RowRefNode = { kind: 'row_ref'; id: string; rowId: string };
type DaysExpr =
  | { kind: 'days_in_state'; id: string }
  | { kind: 'days_in_states'; id: string; stateIds: string[] };

const isDays = (e: unknown): e is DaysExpr =>
  !!e &&
  typeof e === 'object' &&
  ((e as { kind?: string }).kind === 'days_in_state' ||
    (e as { kind?: string }).kind === 'days_in_states');

interface TreeOps {
  update: (node: ConditionNode) => void;
  /** Adds any node, e.g. a state rule's state or row reference. */
  add?: (groupId: string, node: ConditionNode) => void;
  addComparison: (groupId: string) => void;
  addGroup: (groupId: string) => void;
  remove: (id: string) => void;
  move: (id: string, delta: -1 | 1) => void;
  duplicate: (id: string) => void;
}

function findParent(
  group: ConditionGroup,
  id: string,
): { parent: ConditionGroup; index: number } | undefined {
  const index = group.children.findIndex((c) => c.id === id);
  if (index >= 0) return { parent: group, index };
  for (const child of group.children) {
    if (child.kind === 'group') {
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function newComparison(instrumentId: string): Comparison {
  return {
    kind: 'comparison',
    id: randomId(),
    left: newExpr('market', instrumentId),
    operator: 'gt',
    right: newExpr('constant', instrumentId),
  };
}

const MAX_GROUP_DEPTH = 6;

/**
 * Entry or Exit condition tree (Design v1.0 §6.4): nested AND/OR groups with
 * NOT, and add, remove, reorder and duplicate for every condition and group.
 * Grouping is shown by nesting, a labelled border, and AND/OR words between
 * siblings, never by colour alone.
 */
export function ConditionTreeEditor({
  root,
  onChange,
  label,
  path,
  machine,
}: {
  root: ConditionGroup;
  onChange: (root: ConditionGroup) => void;
  label: string;
  path: Path;
  /** Set for a state machine's row rule (ADR 0124 P3b). */
  machine?: MachineRuleScope | undefined;
}) {
  const editor = useEditor();
  const instrumentId = defaultInstrumentOf(editor);

  const ops: TreeOps = {
    update: (node) => onChange(replaceNode(root, node)),
    add: (groupId, node) => onChange(insertNode(root, groupId, node)),
    addComparison: (groupId) => onChange(insertNode(root, groupId, newComparison(instrumentId))),
    addGroup: (groupId) =>
      onChange(
        insertNode(root, groupId, {
          kind: 'group',
          id: randomId(),
          op: 'or',
          negate: false,
          children: [newComparison(instrumentId)],
        }),
      ),
    remove: (id) => onChange(removeNode(root, id)),
    move: (id, delta) => {
      const found = findParent(root, id);
      if (!found) return;
      const target = found.index + delta;
      if (target < 0 || target >= found.parent.children.length) return;
      onChange(moveNode(root, id, found.parent.id, target));
    },
    duplicate: (id) => onChange(duplicateNode(root, id)),
  };

  const tree = (
    <GroupEditor group={root} ops={ops} label={label} number="" path={path} depth={1} isRoot />
  );
  return machine ? <MachineScope.Provider value={machine}>{tree}</MachineScope.Provider> : tree;
}

function GroupEditor({
  group,
  ops,
  label,
  number,
  path,
  depth,
  isRoot = false,
  index = 0,
  siblings = 1,
}: {
  group: ConditionGroup;
  ops: TreeOps;
  label: string;
  number: string;
  path: Path;
  depth: number;
  isRoot?: boolean;
  index?: number;
  siblings?: number;
}) {
  const { instruments, issueAt, editable, optionUnderlyings = [] } = useEditor();
  const scope = useContext(MachineScope);
  // A recorded options underlying may not be in the person's own list until saved.
  const symbol = (id: string) =>
    instruments.find((i) => i.id === id)?.symbol ??
    optionUnderlyings.find((u) => u.id === id)?.symbol;
  const word = group.op === 'and' ? 'AND' : 'OR';
  const error = issueAt(path);

  return (
    <section
      aria-label={label}
      className={cx(
        'rounded-lg border-2 p-3',
        group.negate ? 'border-dashed border-warn' : 'border-line border-l-4 border-l-cond',
        depth % 2 === 1 ? 'bg-cond-soft' : 'bg-surface',
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        <MiniSelect
          id={`${group.id}-op`}
          label={isRoot ? 'Qualifies when' : `Group ${number} qualifies when`}
          value={group.op}
          disabled={!editable}
          onChange={(e) => ops.update({ ...group, op: e.target.value as 'and' | 'or' })}
          className="w-64"
        >
          <option value="and">ALL of these are true (AND)</option>
          <option value="or">ANY of these is true (OR)</option>
        </MiniSelect>
        <label className="flex items-center gap-1.5 pb-1 text-sm">
          <input
            type="checkbox"
            checked={group.negate}
            disabled={!editable}
            onChange={(e) => ops.update({ ...group, negate: e.target.checked })}
          />
          NOT: qualify when this group is false
        </label>
        {!isRoot && editable && (
          <div className="ml-auto flex gap-1">
            <NodeActions
              id={group.id}
              what={`group ${number}`}
              ops={ops}
              index={index}
              siblings={siblings}
            />
          </div>
        )}
      </div>
      {error && <p className="mt-1 text-xs font-medium text-danger">{error}</p>}

      {group.children.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          No conditions yet. Add a condition to compare market data, indicators or values.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {group.children.map((child, i) => {
            const n = number ? `${number}.${i + 1}` : String(i + 1);
            const childPath = [...path, 'children', i];
            return (
              <li key={child.id}>
                {i > 0 && (
                  <p
                    aria-hidden="true"
                    className="mb-2 text-xs font-bold tracking-wide text-ink-muted"
                  >
                    {group.negate ? `${word} (negated group)` : word}
                  </p>
                )}
                {child.kind === 'group' ? (
                  <GroupEditor
                    group={child}
                    ops={ops}
                    label={`Group ${n}`}
                    number={n}
                    path={childPath}
                    depth={depth + 1}
                    index={i}
                    siblings={group.children.length}
                  />
                ) : (child as { kind: string }).kind === 'state_is' && scope ? (
                  <StateIsEditor
                    node={child as unknown as StateIsNode}
                    scope={scope}
                    ops={ops}
                    number={n}
                    index={i}
                    siblings={group.children.length}
                  />
                ) : (child as { kind: string }).kind === 'row_ref' && scope ? (
                  <RowRefEditor
                    node={child as unknown as RowRefNode}
                    scope={scope}
                    ops={ops}
                    number={n}
                    index={i}
                    siblings={group.children.length}
                  />
                ) : (
                  <ComparisonEditor
                    comparison={child}
                    ops={ops}
                    number={n}
                    path={childPath}
                    index={i}
                    siblings={group.children.length}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}

      {editable && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
            onClick={() => ops.addComparison(group.id)}
            aria-label={isRoot ? `Add condition to ${label}` : `Add condition to group ${number}`}
          >
            + Add condition
          </button>
          <button
            type="button"
            className="rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            disabled={depth >= MAX_GROUP_DEPTH}
            onClick={() => ops.addGroup(group.id)}
            aria-label={isRoot ? `Add group to ${label}` : `Add group to group ${number}`}
          >
            + Add group
          </button>
          {scope && scope.states.length > 0 && (
            <button
              type="button"
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
              onClick={() =>
                ops.add?.(group.id, {
                  kind: 'state_is',
                  id: randomId(),
                  which: 'current',
                  stateIds: scope.states[0] ? [scope.states[0].id] : [],
                } as unknown as ConditionNode)
              }
            >
              + State is
            </button>
          )}
          {scope && scope.rows.length > 0 && (
            <button
              type="button"
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-sm font-medium hover:bg-surface-2"
              onClick={() =>
                ops.add?.(group.id, {
                  kind: 'row_ref',
                  id: randomId(),
                  rowId: scope.rows[0]?.id ?? '',
                } as unknown as ConditionNode)
              }
            >
              + Same rule as a row
            </button>
          )}
        </div>
      )}
      {isRoot && group.children.length > 0 && (
        <p className="mt-3 max-w-prose text-sm leading-relaxed">
          <span className="text-xs font-semibold text-ink-muted">Reads as:</span>{' '}
          <span className="text-prose">
            {scope
              ? describeMachineCondition(
                  group as never,
                  symbol,
                  (id) => scope.states.find((x) => x.id === id)?.name,
                  (id) => {
                    const r = scope.rows.find((x) => x.id === id);
                    return r ? `row ${r.number}` : 'a removed row';
                  },
                )
              : describeCondition(group, symbol)}
          </span>
        </p>
      )}
    </section>
  );
}

function NodeActions({
  id,
  what,
  ops,
  index,
  siblings,
}: {
  id: string;
  what: string;
  ops: TreeOps;
  index: number;
  siblings: number;
}) {
  return (
    <>
      <RowButton label={`Move ${what} up`} disabled={index === 0} onClick={() => ops.move(id, -1)}>
        ↑ Up
      </RowButton>
      <RowButton
        label={`Move ${what} down`}
        disabled={index === siblings - 1}
        onClick={() => ops.move(id, 1)}
      >
        ↓ Down
      </RowButton>
      <RowButton label={`Duplicate ${what}`} onClick={() => ops.duplicate(id)}>
        Duplicate
      </RowButton>
      <RowButton label={`Remove ${what}`} className="text-danger" onClick={() => ops.remove(id)}>
        Remove
      </RowButton>
    </>
  );
}

function withOperator(
  c: Comparison,
  operator: ComparisonOperator,
  instrumentId: string,
): Comparison {
  const unary = UNARY_OPERATORS.includes(operator);
  const range = RANGE_OPERATORS.includes(operator);
  const right = unary ? undefined : (c.right ?? newExpr('constant', instrumentId));
  const upper = range ? (c.upper ?? newExpr('constant', instrumentId)) : undefined;
  return {
    kind: 'comparison',
    id: c.id,
    left: c.left,
    operator,
    ...(right ? { right } : {}),
    ...(upper ? { upper } : {}),
  };
}

/**
 * A new left side. A yes/no metric such as Earnings window defaults to "Not
 * needed" (N216); moving off one picks "is greater than" again.
 */
function withLeft(c: Comparison, left: Comparison['left'], instrumentId: string): Comparison {
  const next = { ...c, left };
  if (isYesNoExpr(left) && !isYesNoExpr(c.left)) return withOperator(next, 'is_true', instrumentId);
  if (!isYesNoExpr(left) && c.operator === 'is_true') return withOperator(next, 'gt', instrumentId);
  return next;
}

function ComparisonEditor({
  comparison: c,
  ops,
  number,
  path,
  index,
  siblings,
}: {
  comparison: Comparison;
  ops: TreeOps;
  number: string;
  path: Path;
  index: number;
  siblings: number;
}) {
  const editor = useEditor();
  const { editable } = editor;
  const instrumentId = defaultInstrumentOf(editor);
  const range = RANGE_OPERATORS.includes(c.operator);
  const unary = UNARY_OPERATORS.includes(c.operator);
  const yesNo = isYesNoExpr(c.left);
  const scope = useContext(MachineScope);
  const days = isDays(c.left);

  return (
    <div
      role="group"
      aria-label={`Condition ${number}`}
      className="rounded-md border border-line bg-surface p-2"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-muted">Condition {number}</span>
        {editable && (
          <div className="flex gap-1">
            <NodeActions
              id={c.id}
              what={`condition ${number}`}
              ops={ops}
              index={index}
              siblings={siblings}
            />
          </div>
        )}
      </div>
      <div className="grid gap-2">
        {scope && (
          <div className="sm:max-w-xs">
            <MiniSelect
              id={`${c.id}-left-kind`}
              label="Left side reads"
              value={days ? (c.left as unknown as DaysExpr).kind : 'value'}
              disabled={!editable}
              onChange={(e) => {
                const kind = e.target.value;
                const left =
                  kind === 'value'
                    ? newExpr('market', instrumentId)
                    : kind === 'days_in_state'
                      ? ({ kind, id: randomId() } as unknown as Comparison['left'])
                      : ({
                          kind,
                          id: randomId(),
                          stateIds: scope.states[0] ? [scope.states[0].id] : [],
                        } as unknown as Comparison['left']);
                const next = { ...c, left };
                ops.update(
                  kind === 'value'
                    ? next
                    : withOperator({ ...next, operator: 'lt' }, 'lt', instrumentId),
                );
              }}
            >
              <option value="value">Market data, a metric or a value</option>
              <option value="days_in_state">Days in the current state</option>
              <option value="days_in_states">Days in any of these states</option>
            </MiniSelect>
          </div>
        )}
        {days && scope ? (
          (c.left as unknown as DaysExpr).kind === 'days_in_states' ? (
            <StatePicker
              id={`${c.id}-days-states`}
              legend="Days spent in any of"
              scope={scope}
              value={(c.left as unknown as { stateIds: string[] }).stateIds}
              onChange={(stateIds) =>
                ops.update({ ...c, left: { ...(c.left as object), stateIds } as never })
              }
            />
          ) : (
            <p className="text-sm text-content">
              Days in the current state (the day it was entered is day 1).
            </p>
          )
        ) : (
          <ExpressionEditor
            expr={c.left}
            legend="Left side"
            path={[...path, 'left']}
            onChange={(left) => ops.update(withLeft(c, left, instrumentId))}
          />
        )}
        <div className="sm:max-w-xs">
          <MiniSelect
            id={`${c.id}-operator`}
            label="Comparison"
            value={c.operator}
            disabled={!editable}
            onChange={(e) =>
              ops.update(withOperator(c, e.target.value as ComparisonOperator, instrumentId))
            }
          >
            {/* "Not needed" only for a yes/no metric (N216). */}
            {COMPARISON_OPERATORS.filter(
              (op) => op !== 'is_true' || yesNo || c.operator === 'is_true',
            ).map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </MiniSelect>
          {c.operator === 'is_true' && (
            <p className="mt-1 text-xs text-ink-muted">
              Holds when the metric says yes, for example inside the earnings window.
            </p>
          )}
        </div>
        {!unary && c.right && (
          <div className="space-y-2">
            <ExpressionEditor
              expr={c.right}
              legend={range ? 'Lower bound' : 'Right side'}
              path={[...path, 'right']}
              onChange={(right) => ops.update({ ...c, right })}
            />
            {range && c.upper && (
              <ExpressionEditor
                expr={c.upper}
                legend="Upper bound"
                path={[...path, 'upper']}
                onChange={(upper) => ops.update({ ...c, upper })}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Several of the strategy's states, as checkboxes. */
function StatePicker({
  id,
  legend,
  scope,
  value,
  onChange,
}: {
  id: string;
  legend: string;
  scope: MachineRuleScope;
  value: readonly string[];
  onChange: (stateIds: string[]) => void;
}) {
  const { editable } = useEditor();
  return (
    <fieldset id={id} className="rounded-md border border-line p-2">
      <legend className="px-1 text-xs font-semibold text-ink-muted">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {scope.states.map((st) => (
          <label key={st.id} className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              disabled={!editable}
              checked={value.includes(st.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? scope.states.map((x) => x.id).filter((x) => x === st.id || value.includes(x))
                    : value.filter((x) => x !== st.id),
                )
              }
            />
            {st.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StateIsEditor({
  node,
  scope,
  ops,
  number,
  index,
  siblings,
}: {
  node: StateIsNode;
  scope: MachineRuleScope;
  ops: TreeOps;
  number: string;
  index: number;
  siblings: number;
}) {
  const { editable } = useEditor();
  const update = (patch: Partial<StateIsNode>) =>
    ops.update({ ...node, ...patch } as unknown as ConditionNode);
  return (
    <div
      role="group"
      aria-label={`Condition ${number}`}
      className="rounded-md border border-line bg-surface p-2"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-muted">Condition {number}: state</span>
        {editable && (
          <div className="flex gap-1">
            <NodeActions
              id={node.id}
              what={`condition ${number}`}
              ops={ops}
              index={index}
              siblings={siblings}
            />
          </div>
        )}
      </div>
      <div className="grid gap-2">
        <div className="sm:max-w-xs">
          <MiniSelect
            id={`${node.id}-which`}
            label="Which state"
            value={node.which}
            disabled={!editable}
            onChange={(e) => update({ which: e.target.value as 'current' | 'prior' })}
          >
            <option value="current">The current state is one of</option>
            <option value="prior">The state before it was one of</option>
          </MiniSelect>
        </div>
        <StatePicker
          id={`${node.id}-states`}
          legend="States"
          scope={scope}
          value={node.stateIds}
          onChange={(stateIds) => update({ stateIds })}
        />
      </div>
    </div>
  );
}

function RowRefEditor({
  node,
  scope,
  ops,
  number,
  index,
  siblings,
}: {
  node: RowRefNode;
  scope: MachineRuleScope;
  ops: TreeOps;
  number: string;
  index: number;
  siblings: number;
}) {
  const { editable } = useEditor();
  return (
    <div
      role="group"
      aria-label={`Condition ${number}`}
      className="rounded-md border border-line bg-surface p-2"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-muted">
          Condition {number}: another row's rule
        </span>
        {editable && (
          <div className="flex gap-1">
            <NodeActions
              id={node.id}
              what={`condition ${number}`}
              ops={ops}
              index={index}
              siblings={siblings}
            />
          </div>
        )}
      </div>
      <div className="sm:max-w-sm">
        <MiniSelect
          id={`${node.id}-row`}
          label="Same rule as"
          value={node.rowId}
          disabled={!editable}
          onChange={(e) =>
            ops.update({ ...node, rowId: e.target.value } as unknown as ConditionNode)
          }
        >
          {!scope.rows.some((r) => r.id === node.rowId) && (
            <option value={node.rowId}>A removed row</option>
          )}
          {scope.rows.map((r) => (
            <option key={r.id} value={r.id}>
              Row {r.number}
              {r.label ? `: ${r.label}` : ''}
            </option>
          ))}
        </MiniSelect>
        <p className="mt-1 text-xs text-ink-muted">
          Reads that row's rule as it is saved, so the two never drift apart.
        </p>
      </div>
    </div>
  );
}
