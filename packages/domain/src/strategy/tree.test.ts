import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sequentialIds } from './ids';
import type { ConditionGroup, ConditionNode, Expr } from './schema';
import { comparison, constant, indicator, market, STOCK_B, validDefinition } from './test-fixtures';
import {
  allOrders,
  cloneNode,
  collectInstrumentUses,
  duplicateNode,
  exprDepth,
  findNode,
  insertNode,
  moveNode,
  removeNode,
  replaceNode,
  treeDepth,
  walkComparisons,
  walkExpressions,
} from './tree';

const c1 = comparison('c1', market('m1'), 'gt', constant('1'));
const c2 = comparison('c2', market('m2'), 'lt', constant('2'));
const c3 = comparison('c3', market('m3'), 'eq', constant('3'));

function sample(): ConditionGroup {
  return {
    kind: 'group',
    id: 'root',
    op: 'and',
    negate: false,
    children: [c1, { kind: 'group', id: 'inner', op: 'or', negate: false, children: [c2, c3] }],
  };
}

const ids = (node: ConditionNode): string[] =>
  node.kind === 'group' ? [node.id, ...node.children.flatMap(ids)] : [node.id];

describe('condition tree edits', () => {
  it('finds nodes at any depth', () => {
    expect(findNode(sample(), 'c3')).toBe(c3);
    expect(findNode(sample(), 'missing')).toBeUndefined();
  });

  it('inserts at a position without touching the input', () => {
    const root = sample();
    const before = structuredClone(root);
    const c4 = comparison('c4', market('m4'), 'gt', constant('4'));
    const next = insertNode(root, 'inner', c4, 1);
    expect(root).toEqual(before);
    expect(ids(next)).toEqual(['root', 'c1', 'inner', 'c2', 'c4', 'c3']);
  });

  it('refuses to insert into a comparison or a missing group', () => {
    expect(() => insertNode(sample(), 'c1', c3)).toThrow();
    expect(() => insertNode(sample(), 'nope', c3)).toThrow();
  });

  it('keeps untouched branches by reference', () => {
    const root = sample();
    const next = insertNode(root, 'root', comparison('c4', market('m4'), 'gt', constant('4')));
    expect(next.children[1]).toBe(root.children[1]);
    expect(removeNode(root, 'c1').children[0]).toBe(root.children[1]);
  });

  it('removes nodes but never the root', () => {
    expect(ids(removeNode(sample(), 'inner'))).toEqual(['root', 'c1']);
    expect(() => removeNode(sample(), 'root')).toThrow();
  });

  it('replaces a node by id', () => {
    const replacement = { ...c2, operator: 'gte' as const };
    const next = replaceNode(sample(), replacement);
    expect(findNode(next, 'c2')).toEqual(replacement);
    expect(() => replaceNode(sample(), { ...c1, id: 'root' })).toThrow();
  });

  it('moves nodes between groups', () => {
    expect(ids(moveNode(sample(), 'c1', 'inner', 0))).toEqual(['root', 'inner', 'c1', 'c2', 'c3']);
    expect(ids(moveNode(sample(), 'c3', 'root', 0))).toEqual(['root', 'c3', 'c1', 'inner', 'c2']);
  });

  it('refuses to move a group inside itself', () => {
    expect(() => moveNode(sample(), 'inner', 'inner', 0)).toThrow();
    const nested = insertNode(sample(), 'inner', {
      kind: 'group',
      id: 'deeper',
      op: 'and',
      negate: false,
      children: [],
    });
    expect(() => moveNode(nested, 'inner', 'deeper', 0)).toThrow();
    expect(() => moveNode(sample(), 'root', 'inner', 0)).toThrow();
  });

  it('duplicates with fresh ids, including expression ids', () => {
    const next = duplicateNode(sample(), 'inner', sequentialIds('d'));
    expect(ids(next)).toEqual(['root', 'c1', 'inner', 'c2', 'c3', 'd1', 'd2', 'd5']);
    const all = [...walkExpressions(next)].map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it('clones calculation arguments with fresh ids', () => {
    const calc: Expr = {
      kind: 'calc',
      id: 'k',
      op: 'add',
      args: [market('a'), constant('1', 'b')],
    };
    const copy = cloneNode(comparison('x', calc, 'gt', constant('0', 'z')), sequentialIds('n'));
    expect([...walkExpressions(copy)].map((e) => e.id)).toEqual(['n2', 'n3', 'n4', 'n5']);
  });
});

describe('tree walks', () => {
  it('measures depth', () => {
    expect(treeDepth(sample())).toBe(3);
    expect(treeDepth({ kind: 'group', id: 'g', op: 'and', negate: false, children: [] })).toBe(1);
    expect(exprDepth(constant('1'))).toBe(1);
    expect(exprDepth({ kind: 'calc', id: 'k', op: 'neg', args: [constant('1')] })).toBe(2);
  });

  it('lists comparisons in order', () => {
    expect([...walkComparisons(sample())].map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('collects every instrument a strategy touches', () => {
    const def = validDefinition();
    def.exit.orders[0]!.orderType = 'limit';
    def.exit.orders[0]!.limitPrice = indicator('lp', { instrumentId: STOCK_B });
    const uses = collectInstrumentUses(def);
    expect(uses).toContainEqual({ instrumentId: STOCK_B, phase: 'exit', role: 'condition' });
    expect(uses.filter((u) => u.role === 'order')).toHaveLength(2);
    expect(allOrders(def).map((o) => o.phase)).toEqual(['entry', 'exit']);
  });
});

// ---------------------------------------------------------------------------
// Property tests: random edit sequences keep the tree well-formed.

type Op =
  | { kind: 'insert'; parent: number; group: boolean }
  | { kind: 'remove'; target: number }
  | { kind: 'move'; target: number; parent: number; index: number }
  | { kind: 'duplicate'; target: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('insert' as const), parent: fc.nat(), group: fc.boolean() }),
  fc.record({ kind: fc.constant('remove' as const), target: fc.nat() }),
  fc.record({
    kind: fc.constant('move' as const),
    target: fc.nat(),
    parent: fc.nat(),
    index: fc.nat(),
  }),
  fc.record({ kind: fc.constant('duplicate' as const), target: fc.nat() }),
);

function groups(node: ConditionNode): ConditionGroup[] {
  return node.kind === 'group' ? [node, ...node.children.flatMap(groups)] : [];
}
const countNodes = (node: ConditionNode): number => ids(node).length;

describe('condition tree properties', () => {
  it('keeps ids unique and the root intact through any edit sequence', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const next = sequentialIds('p');
        let root: ConditionGroup = {
          kind: 'group',
          id: 'root',
          op: 'and',
          negate: false,
          children: [],
        };
        for (const op of ops) {
          const all = ids(root);
          const gs = groups(root);
          const before = countNodes(root);
          const pick = <T>(xs: T[], n: number) => xs[n % xs.length] as T;
          switch (op.kind) {
            case 'insert': {
              const node: ConditionNode = op.group
                ? { kind: 'group', id: next(), op: 'or', negate: false, children: [] }
                : comparison(next(), market(next()), 'gt', constant('1', next()));
              root = insertNode(root, pick(gs, op.parent).id, node);
              expect(countNodes(root)).toBe(before + 1);
              break;
            }
            case 'remove': {
              const target = pick(all, op.target);
              if (target === 'root') {
                expect(() => removeNode(root, target)).toThrow();
              } else {
                root = removeNode(root, target);
                expect(findNode(root, target)).toBeUndefined();
              }
              break;
            }
            case 'move': {
              const target = pick(all, op.target);
              const parent = pick(gs, op.parent);
              const moved = findNode(root, target);
              const illegal =
                target === 'root' ||
                target === parent.id ||
                (moved?.kind === 'group' && !!findNode(moved, parent.id));
              if (illegal) {
                expect(() => moveNode(root, target, parent.id, op.index)).toThrow();
              } else {
                root = moveNode(root, target, parent.id, op.index);
                expect(countNodes(root)).toBe(before);
              }
              break;
            }
            case 'duplicate': {
              const target = pick(all, op.target);
              if (target === 'root') {
                expect(() => duplicateNode(root, target, next)).toThrow();
              } else {
                const size = countNodes(findNode(root, target)!);
                root = duplicateNode(root, target, next);
                expect(countNodes(root)).toBe(before + size);
              }
              break;
            }
          }
          const after = ids(root);
          expect(new Set(after).size).toBe(after.length);
          expect(root.id).toBe('root');
        }
      }),
      { numRuns: 300 },
    );
  });
});
