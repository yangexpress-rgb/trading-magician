import type { PositionDirection, EntryPhase, StrategyDefinition } from './schema';

/**
 * Entry groups (Design v1.2 item 8). A strategy's own Entry and Exit are its
 * first group; `groups` adds more, each with its own direction, Entry and
 * Exit. Every group runs exactly like a strategy of its own (its "group
 * definition"), under one rule: the strategy holds at most one position at a
 * time, so a group can enter only while no cycle of any group is open, and
 * nothing flips a position from one direction to the other.
 */

/** A group's key: `null` for the strategy's own Entry and Exit, else the group's id. */
export type GroupKey = string | null;

export interface EntryGroupView {
  key: GroupKey;
  label: string;
  direction: PositionDirection;
  /** The group as a strategy of its own: its Entry and Exit, the strategy's other settings. */
  definition: StrategyDefinition;
}

/** A group's direction: as set, else "short" when every Entry leg sells short. */
export function directionOf(entry: EntryPhase): PositionDirection {
  if (entry.direction) return entry.direction;
  return entry.orders.length > 0 && entry.orders.every((o) => o.side === 'sell_short')
    ? 'short'
    : 'long';
}

export const hasGroups = (def: StrategyDefinition) => (def.groups?.length ?? 0) > 0;

/** Whether results should say which direction each trade took. */
export const isTwoSided = (def: StrategyDefinition) =>
  hasGroups(def) || def.entry.direction !== undefined;

/** The definition one group runs. The strategy's own group is the strategy itself. */
export function groupDefinition(def: StrategyDefinition, key: GroupKey): StrategyDefinition {
  if (key === null) return def;
  const g = def.groups?.find((x) => x.id === key);
  if (!g) throw new Error(`No entry group ${key}`);
  const { groups: _drop, ...rest } = def;
  void _drop;
  return {
    ...rest,
    entry: g.entry,
    exit: g.exit,
    // Leg order lists the strategy's own legs; a group's legs go in the order listed.
    execution: { ...def.execution, legOrder: undefined },
  };
}

/** Every entry group, the strategy's own first. */
export function entryGroups(def: StrategyDefinition): EntryGroupView[] {
  const own: EntryGroupView = {
    key: null,
    label: hasGroups(def) ? 'Group 1' : 'Entry',
    direction: directionOf(def.entry),
    definition: def,
  };
  return [
    own,
    ...(def.groups ?? []).map((g) => ({
      key: g.id,
      label: g.label,
      direction: directionOf(g.entry),
      definition: groupDefinition(def, g.id),
    })),
  ];
}
