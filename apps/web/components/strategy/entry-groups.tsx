'use client';

import {
  directionOf,
  emptyGroup,
  groupDefinition,
  randomId,
  refillExitOrders,
  DEFAULT_TRIGGER,
  type EntryGroup,
  type PositionDirection,
  type StrategyDefinition,
} from '@tm/domain';
import { Button } from '@tm/ui';
import { useMemo, useState, type ReactNode } from 'react';
import { EditorContext, useEditor } from './editor-context';
import { MiniInput } from './fields';

/**
 * Entry groups (Design v1.2 item 8): the strategy's own Entry and Exit are
 * group 1; further groups each have a direction, an Entry and an Exit. Each
 * group is edited with the same Entry and Exit editors, on the group's own
 * definition, so everything those editors do applies unchanged.
 */

export const MAX_GROUPS = 3;

export const DIRECTION_LABELS: Record<PositionDirection, string> = {
  long: 'Long: Entry buys, Exit sells',
  short: 'Short: Entry sells short, Exit buys to cover',
};

/**
 * Long or short, shown, not chosen (ADR 0049): direction comes from the Entry
 * legs' sides (Buy is long, Sell short is short), so it can never disagree with them.
 */
export function DirectionField({ definition, id }: { definition: StrategyDefinition; id: string }) {
  const direction = directionOf(definition.entry);
  return (
    <p id={id} className="mb-3 text-sm">
      <span className="font-semibold">Direction:</span> {DIRECTION_LABELS[direction]}{' '}
      <span className="text-ink-muted">(from the Entry legs&rsquo; side)</span>
    </p>
  );
}

/** A new group: the opposite direction of group 1, its Entry legs mirrored, empty conditions. */
export function addGroup(def: StrategyDefinition): StrategyDefinition {
  const groups = def.groups ?? [];
  const direction: PositionDirection = directionOf(def.entry) === 'long' ? 'short' : 'long';
  const side = direction === 'long' ? 'buy' : 'sell_short';
  const base: StrategyDefinition = {
    ...def,
    entry: {
      condition: emptyGroup(),
      trigger: { ...def.entry.trigger },
      orders: def.entry.orders.map((o) => {
        const { legCondition: _drop, ...rest } = o;
        void _drop;
        return { ...rest, id: randomId(), side, legLabel: `${o.legLabel} (${direction})` };
      }),
    },
    exit: {
      condition: emptyGroup(),
      trigger: { ...(def.exit.trigger ?? DEFAULT_TRIGGER) },
      orders: [],
      mirrorEntry: true,
    },
  };
  const filled = refillExitOrders(base);
  const group: EntryGroup = {
    id: randomId(),
    label: `Group ${groups.length + 2}`,
    entry: filled.entry,
    exit: { ...filled.exit, orders: filled.exit.orders.map((o) => ({ ...o, id: randomId() })) },
  };
  return {
    ...def,
    // Several groups hold one position at a time (validated as well).
    execution: { ...def.execution, reentry: { mode: 'single_cycle' } },
    groups: [...groups, group],
  };
}

export function removeGroup(def: StrategyDefinition, groupId: string): StrategyDefinition {
  const groups = (def.groups ?? []).filter((g) => g.id !== groupId);
  const { groups: _g, ...rest } = def;
  void _g;
  return groups.length > 0 ? { ...rest, groups } : rest;
}

/**
 * Renders `children` with group `index`'s own definition: edits go back into
 * the group, and problems are looked up under `groups.<index>`.
 */
export function GroupScope({
  definition,
  index,
  onChange,
  children,
}: {
  definition: StrategyDefinition;
  index: number;
  onChange: (next: (d: StrategyDefinition) => StrategyDefinition) => void;
  children: (def: StrategyDefinition, onChange: (def: StrategyDefinition) => void) => ReactNode;
}) {
  const parent = useEditor();
  const group = definition.groups?.[index];
  const scoped = useMemo(
    () => ({
      ...parent,
      issueAt: (path: readonly (string | number)[]) => parent.issueAt(['groups', index, ...path]),
    }),
    [parent, index],
  );
  if (!group) return null;
  const own = groupDefinition(definition, group.id);
  const set = (next: StrategyDefinition) =>
    onChange((d) => ({
      ...d,
      groups: (d.groups ?? []).map((g, i) =>
        i === index ? { ...g, entry: next.entry, exit: next.exit } : g,
      ),
    }));
  return <EditorContext.Provider value={scoped}>{children(own, set)}</EditorContext.Provider>;
}

/** The group's name and a button to remove it. */
export function GroupHeader({
  definition,
  index,
  onChange,
}: {
  definition: StrategyDefinition;
  index: number;
  onChange: (next: (d: StrategyDefinition) => StrategyDefinition) => void;
}) {
  const { editable, issueAt } = useEditor();
  // Asked on the page, not in a browser dialog: some browsers and embedded
  // views block window.confirm, which left the button doing nothing.
  const [confirming, setConfirming] = useState(false);
  const group = definition.groups?.[index];
  if (!group) return null;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-64">
        <MiniInput
          id={`group-${group.id}-label`}
          label={`Entry group ${index + 2} name`}
          value={group.label}
          error={issueAt(['groups', index, 'label'])}
          disabled={!editable}
          onChange={(e) =>
            onChange((d) => ({
              ...d,
              groups: (d.groups ?? []).map((g, i) =>
                i === index ? { ...g, label: e.target.value } : g,
              ),
            }))
          }
        />
      </div>
      {editable && !confirming && (
        <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
          Remove group
        </Button>
      )}
      {editable && confirming && (
        <div
          role="group"
          aria-label="Confirm removal"
          className="flex flex-wrap items-center gap-2"
        >
          <span className="text-sm">Remove “{group.label}” with its Entry and Exit?</span>
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setConfirming(false);
              onChange((d) => removeGroup(d, group.id));
            }}
          >
            Yes, remove
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      )}
    </div>
  );
}
