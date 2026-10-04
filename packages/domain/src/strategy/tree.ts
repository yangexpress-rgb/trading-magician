import { randomId, type IdFactory } from './ids';
import type {
  Comparison,
  ConditionGroup,
  ConditionNode,
  Expr,
  NodeId,
  PhaseName,
  PlannedOrder,
  StrategyDefinition,
} from './schema';

/**
 * Immutable operations on condition trees. Every function returns a new tree
 * and leaves its input untouched, so editor state, undo and versioning stay
 * simple.
 */

export function findNode(root: ConditionGroup, id: NodeId): ConditionNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    if (child.id === id) return child;
    if (child.kind === 'group') {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

function mapGroups(
  group: ConditionGroup,
  fn: (g: ConditionGroup) => ConditionGroup,
): ConditionGroup {
  const children = group.children.map((c) => (c.kind === 'group' ? mapGroups(c, fn) : c));
  return fn(children.every((c, i) => c === group.children[i]) ? group : { ...group, children });
}

/** Inserts `node` into the group `parentId` at `index` (default: end). */
export function insertNode(
  root: ConditionGroup,
  parentId: NodeId,
  node: ConditionNode,
  index?: number,
): ConditionGroup {
  if (!findNode(root, parentId) || findNode(root, parentId)?.kind !== 'group') {
    throw new Error(`No group with id ${parentId}`);
  }
  return mapGroups(root, (g) => {
    if (g.id !== parentId) return g;
    const children = [...g.children];
    children.splice(index ?? children.length, 0, node);
    return { ...g, children };
  });
}

/** Removes a node anywhere below the root. The root itself cannot be removed. */
export function removeNode(root: ConditionGroup, id: NodeId): ConditionGroup {
  if (root.id === id) throw new Error('The top-level group cannot be removed');
  return mapGroups(root, (g) =>
    g.children.some((c) => c.id === id)
      ? { ...g, children: g.children.filter((c) => c.id !== id) }
      : g,
  );
}

/** Replaces the node with the same id. */
export function replaceNode(root: ConditionGroup, node: ConditionNode): ConditionGroup {
  if (root.id === node.id) {
    if (node.kind !== 'group') throw new Error('The top level must stay a group');
    return node;
  }
  return mapGroups(root, (g) =>
    g.children.some((c) => c.id === node.id)
      ? { ...g, children: g.children.map((c) => (c.id === node.id ? node : c)) }
      : g,
  );
}

function isAncestor(root: ConditionGroup, ancestorId: NodeId, id: NodeId): boolean {
  const ancestor = findNode(root, ancestorId);
  return ancestor?.kind === 'group' && ancestor.id !== id && !!findNode(ancestor, id);
}

/** Moves a node to another group (or another position in the same group). */
export function moveNode(
  root: ConditionGroup,
  id: NodeId,
  targetParentId: NodeId,
  index: number,
): ConditionGroup {
  const node = findNode(root, id);
  if (!node || node === root) throw new Error(`Cannot move ${id}`);
  if (id === targetParentId || isAncestor(root, id, targetParentId)) {
    throw new Error('A group cannot be moved inside itself');
  }
  return insertNode(removeNode(root, id), targetParentId, node, index);
}

function cloneExpr(expr: Expr, ids: IdFactory): Expr {
  return expr.kind === 'calc'
    ? { ...expr, id: ids(), args: expr.args.map((a) => cloneExpr(a, ids)) }
    : { ...expr, id: ids() };
}

/** Deep-copies a node with fresh ids. */
export function cloneNode<T extends ConditionNode>(node: T, ids: IdFactory = randomId): T {
  if (node.kind === 'group') {
    return { ...node, id: ids(), children: node.children.map((c) => cloneNode(c, ids)) } as T;
  }
  const c = node as Comparison;
  return {
    ...c,
    id: ids(),
    left: cloneExpr(c.left, ids),
    ...(c.right ? { right: cloneExpr(c.right, ids) } : {}),
    ...(c.upper ? { upper: cloneExpr(c.upper, ids) } : {}),
  } as T;
}

/** Inserts a fresh copy of the node directly after the original. */
export function duplicateNode(
  root: ConditionGroup,
  id: NodeId,
  ids: IdFactory = randomId,
): ConditionGroup {
  const node = findNode(root, id);
  if (!node || node === root) throw new Error(`Cannot duplicate ${id}`);
  const copy = cloneNode(node, ids);
  return mapGroups(root, (g) => {
    const i = g.children.findIndex((c) => c.id === id);
    if (i < 0) return g;
    const children = [...g.children];
    children.splice(i + 1, 0, copy);
    return { ...g, children };
  });
}

/** Visits every expression in a condition tree, including nested calc arguments. */
export function* walkExpressions(node: ConditionNode): Generator<Expr> {
  if (node.kind === 'group') {
    for (const child of node.children) yield* walkExpressions(child);
    return;
  }
  for (const expr of [node.left, node.right, node.upper]) {
    if (expr) yield* walkExpr(expr);
  }
}

export function* walkExpr(expr: Expr): Generator<Expr> {
  yield expr;
  if (expr.kind === 'calc') for (const arg of expr.args) yield* walkExpr(arg);
}

export function* walkComparisons(node: ConditionNode): Generator<Comparison> {
  if (node.kind === 'comparison') yield node;
  else for (const child of node.children) yield* walkComparisons(child);
}

export function treeDepth(node: ConditionNode): number {
  return node.kind === 'group' ? 1 + Math.max(0, ...node.children.map(treeDepth)) : 1;
}

export function exprDepth(expr: Expr): number {
  return expr.kind === 'calc' ? 1 + Math.max(0, ...expr.args.map(exprDepth)) : 1;
}

export interface InstrumentUse {
  instrumentId: string;
  phase: PhaseName;
  role: 'condition' | 'order';
}

/** Every instrument the strategy touches, for indexing and data-feed checks. */
export function collectInstrumentUses(def: StrategyDefinition): InstrumentUse[] {
  const uses: InstrumentUse[] = [];
  for (const phase of ['entry', 'exit'] as const) {
    for (const expr of walkExpressions(def[phase].condition)) {
      if (expr.kind === 'market' || expr.kind === 'indicator') {
        uses.push({ instrumentId: expr.instrumentId, phase, role: 'condition' });
      }
    }
    for (const order of def[phase].orders) {
      uses.push({ instrumentId: order.instrumentId, phase, role: 'order' });
      for (const price of [order.limitPrice, order.stopPrice]) {
        if (!price) continue;
        for (const e of walkExpr(price)) {
          if (e.kind === 'market' || e.kind === 'indicator') {
            uses.push({ instrumentId: e.instrumentId, phase, role: 'condition' });
          }
        }
      }
    }
  }
  return uses;
}

export function allOrders(def: StrategyDefinition): (PlannedOrder & { phase: PhaseName })[] {
  return [
    ...def.entry.orders.map((o) => ({ ...o, phase: 'entry' as const })),
    ...def.exit.orders.map((o) => ({ ...o, phase: 'exit' as const })),
  ];
}
