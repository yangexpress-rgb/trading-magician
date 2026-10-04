import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PlannedOrder, Timing } from './schema';
import { order, validDefinition } from './test-fixtures';
import { checkTiming, findTimingCycles, relativeDelaySeconds } from './timing';

const afterLeg = (legId: string, event: 'submitted' | 'filled' = 'filled'): Timing => ({
  mode: 'relative',
  amount: 1,
  unit: 'min',
  reference: { kind: 'leg', legId, event },
});
const afterPhase = (
  event: Extract<Timing, { mode: 'relative' }>['reference'] & { kind: 'phase' },
) => ({
  mode: 'relative' as const,
  amount: 30,
  unit: 's' as const,
  reference: event,
});

const codes = (def: ReturnType<typeof validDefinition>) => checkTiming(def).map((p) => p.code);

describe('relative delays', () => {
  it('converts units to seconds', () => {
    expect(relativeDelaySeconds({ ...afterLeg('x'), amount: 2, unit: 'h' } as never)).toBe(7200);
    expect(relativeDelaySeconds({ ...afterLeg('x'), amount: 1.5, unit: 'min' } as never)).toBe(90);
  });
});

describe('timing checks', () => {
  it('passes a definition with only immediate legs', () => {
    expect(checkTiming(validDefinition())).toEqual([]);
  });

  it('lets Exit legs wait on Entry legs and Entry legs on each other', () => {
    const def = validDefinition();
    def.entry.orders.push(order('buy-b', { timing: afterLeg('buy-a') }));
    def.exit.orders[0]!.timing = afterLeg('buy-b');
    expect(codes(def)).toEqual([]);
  });

  it('lets Entry legs wait on the Entry trigger only', () => {
    const def = validDefinition();
    def.entry.orders[0]!.timing = afterPhase({ kind: 'phase', event: 'entry_trigger' });
    expect(codes(def)).toEqual([]);
    def.entry.orders[0]!.timing = afterPhase({ kind: 'phase', event: 'entry_full_fill' });
    expect(codes(def)).toEqual(['entry_waits_on_own_phase']);
  });

  it('lets Exit legs wait on Entry phase events', () => {
    const def = validDefinition();
    def.exit.orders[0]!.timing = afterPhase({ kind: 'phase', event: 'position_opened' });
    expect(codes(def)).toEqual([]);
  });

  it('reports self, unknown and backwards references', () => {
    const def = validDefinition();
    def.entry.orders[0]!.timing = afterLeg('buy-a');
    expect(codes(def)).toEqual(['self_reference']);

    def.entry.orders[0]!.timing = afterLeg('deleted-leg');
    expect(codes(def)).toEqual(['unknown_leg_reference']);

    def.entry.orders[0]!.timing = afterLeg('sell-a');
    expect(codes(def)).toEqual(['entry_references_exit']);
  });

  it('reports a cycle once, naming the legs', () => {
    const def = validDefinition();
    def.entry.orders = [
      order('a', { timing: afterLeg('c') }),
      order('b', { timing: afterLeg('a') }),
      order('c', { timing: afterLeg('b') }),
    ];
    const problems = checkTiming(def);
    expect(problems.map((p) => p.code)).toEqual(['timing_cycle']);
    expect(problems[0]!.message).toContain('"a"');
  });

  it('rejects an unknown time zone on an exact time', () => {
    const def = validDefinition();
    def.entry.orders[0]!.timing = {
      mode: 'exact',
      at: '2026-10-06T13:30:00Z',
      zone: 'Mars/Olympus',
    };
    expect(codes(def)).toEqual(['exact_time_invalid_zone']);
  });
});

describe('cycle detection properties', () => {
  /** Orders where leg i may wait on leg j; a cycle exists iff the graph has one. */
  const graphArb = fc
    .integer({ min: 1, max: 8 })
    .chain((n) =>
      fc.tuple(
        fc.constant(n),
        fc.array(fc.option(fc.integer({ min: 0, max: n - 1 })), { minLength: n, maxLength: n }),
      ),
    );

  const build = (deps: (number | null)[]): PlannedOrder[] =>
    deps.map((d, i) => order(`l${i}`, d === null ? {} : { timing: afterLeg(`l${d}`) }));

  /** Reference: follow each leg's single dependency; a revisit is a cycle. */
  const hasCycle = (deps: (number | null)[]) =>
    deps.some((_, start) => {
      const seen = new Set<number>();
      let at: number | null = start;
      while (at !== null) {
        if (seen.has(at)) return true;
        seen.add(at);
        const next: number | null = deps[at] ?? null;
        if (next === at) return false; // self-loops are reported separately
        at = next;
      }
      return false;
    });

  it('finds a cycle exactly when one exists', () => {
    fc.assert(
      fc.property(graphArb, ([, deps]) => {
        expect(findTimingCycles(build(deps)).length > 0).toBe(hasCycle(deps));
      }),
      { numRuns: 500 },
    );
  });

  it('never reports a leg in a cycle it is not part of', () => {
    fc.assert(
      fc.property(graphArb, ([, deps]) => {
        const orders = build(deps);
        for (const cycle of findTimingCycles(orders)) {
          cycle.forEach((id, i) => {
            const next = cycle[(i + 1) % cycle.length];
            const o = orders.find((x) => x.id === id)!;
            expect(
              o.timing.mode === 'relative' &&
                o.timing.reference.kind === 'leg' &&
                o.timing.reference.legId,
            ).toBe(next);
          });
        }
      }),
      { numRuns: 500 },
    );
  });
});
