export interface Leg {
  accountId?: unknown;
}

/** The trading accounts a stored strategy definition's order legs use. */
export function definitionAccounts(def: unknown): string[] {
  const d = def as { entry?: { orders?: Leg[] }; exit?: { orders?: Leg[] } } | null;
  const legs = [...(d?.entry?.orders ?? []), ...(d?.exit?.orders ?? [])];
  return [
    ...new Set(legs.map((l) => l.accountId).filter((a): a is string => typeof a === 'string')),
  ];
}
