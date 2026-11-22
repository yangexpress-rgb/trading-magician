export interface Leg {
  accountId?: unknown;
}

type StoredPhase = { orders?: Leg[] };
type StoredDef = {
  entry?: StoredPhase;
  exit?: StoredPhase;
  groups?: { entry?: StoredPhase; exit?: StoredPhase }[];
} | null;

/** Every order leg of a stored definition, entry groups included. */
function allLegs(def: unknown): Leg[] {
  const d = def as StoredDef;
  return [d?.entry, d?.exit, ...(d?.groups ?? []).flatMap((g) => [g.entry, g.exit])].flatMap(
    (p) => p?.orders ?? [],
  );
}

/** The trading accounts a stored strategy definition's order legs use. */
export function definitionAccounts(def: unknown): string[] {
  const legs = allLegs(def);
  return [
    ...new Set(legs.map((l) => l.accountId).filter((a): a is string => typeof a === 'string')),
  ];
}

/**
 * The account a strategy's legs name, which is where its run goes unless the person
 * picks another (N308): the first Entry leg's, else the first Exit leg's.
 */
export function legsAccount(def: unknown): string | undefined {
  const first = allLegs(def).find((l) => typeof l.accountId === 'string');
  return first?.accountId as string | undefined;
}

type Orders = { orders: readonly { accountId: string }[] };
type Bindable = {
  entry: Orders;
  exit: Orders;
  groups?: readonly { entry: Orders; exit: Orders }[] | undefined;
};

/**
 * The rules as one run trades them (N308): every leg, in every entry group, on the run's
 * account. The stored definition is not changed; a run reads its pinned version through this.
 */
export function bindDefinitionToAccount<T extends Bindable>(def: T, accountId: string): T {
  const phase = <P extends Orders>(p: P): P => ({
    ...p,
    orders: p.orders.map((o) => (o.accountId === accountId ? o : { ...o, accountId })),
  });
  return {
    ...def,
    entry: phase(def.entry),
    exit: phase(def.exit),
    ...(def.groups
      ? { groups: def.groups.map((g) => ({ ...g, entry: phase(g.entry), exit: phase(g.exit) })) }
      : {}),
  };
}
