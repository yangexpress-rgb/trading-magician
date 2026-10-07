'use client';

import {
  COMPARISON_OPERATORS,
  duplicateNode,
  insertNode,
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
import { describeCondition, OPERATOR_LABELS } from '@/lib/strategy-text';
import { useEditor } from './editor-context';
import { ExpressionEditor, newExpr } from './expression-editor';
import { MiniSelect, RowButton } from './fields';

type Path = readonly (string | number)[];

interface TreeOps {
  update: (node: ConditionNode) => void;
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
}: {
  root: ConditionGroup;
  onChange: (root: ConditionGroup) => void;
  label: string;
  path: Path;
}) {
  const { instruments } = useEditor();
  const instrumentId = instruments[0]?.id ?? '';

  const ops: TreeOps = {
    update: (node) => onChange(replaceNode(root, node)),
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

  return (
    <GroupEditor group={root} ops={ops} label={label} number="" path={path} depth={1} isRoot />
  );
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
  const { instruments, issueAt, editable } = useEditor();
  const symbol = (id: string) => instruments.find((i) => i.id === id)?.symbol;
  const word = group.op === 'and' ? 'AND' : 'OR';
  const error = issueAt(path);

  return (
    <section
      aria-label={label}
      className={cx(
        'rounded-lg border-2 p-3',
        group.negate ? 'border-dashed border-warn' : 'border-line',
        depth % 2 === 0 ? 'bg-surface-2' : 'bg-surface',
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
        </div>
      )}
      {isRoot && group.children.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          <span className="font-semibold">Reads as:</span> {describeCondition(group, symbol)}
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
  const { instruments, editable } = useEditor();
  const instrumentId = instruments[0]?.id ?? '';
  const range = RANGE_OPERATORS.includes(c.operator);
  const unary = UNARY_OPERATORS.includes(c.operator);

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
        <ExpressionEditor
          expr={c.left}
          legend="Left side"
          path={[...path, 'left']}
          onChange={(left) => ops.update({ ...c, left })}
        />
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
            {COMPARISON_OPERATORS.map((op) => (
              <option key={op} value={op}>
                {OPERATOR_LABELS[op]}
              </option>
            ))}
          </MiniSelect>
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
