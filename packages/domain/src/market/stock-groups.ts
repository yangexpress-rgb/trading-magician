import { DJI_AS_OF, DJI_MEMBERS, DJI_SOURCE } from './groups/dji-members';
import { NDX_AS_OF, NDX_MEMBERS, NDX_SOURCE } from './groups/ndx-members';
import { R1000_AS_OF, R1000_MEMBERS, R1000_SOURCE } from './groups/r1000-members';
import { R2000_AS_OF, R2000_MEMBERS, R2000_SOURCE } from './groups/r2000-members';
import { SP400_AS_OF, SP400_MEMBERS, SP400_SOURCE } from './groups/sp400-members';
import { SP600_AS_OF, SP600_MEMBERS, SP600_SOURCE } from './groups/sp600-members';
import { SP500_AS_OF, SP500_MEMBERS } from './sp500-members';

/**
 * The built-in stock groups (ADR 0079): the screener's "Stock group" choices
 * and a strategy group's built-in universes. Alpaca does not say which index
 * a stock is in, so each member list ships with the app and is refreshed
 * with `pnpm --filter @tm/domain sp500:update` / `groups:update` (a GitHub
 * workflow runs both monthly). Lists are today's members, so back tests over
 * past years carry survivorship bias.
 */

/** The eleven GICS sectors, each a group of the S&P 500's members in it. */
export const SP500_SECTOR_GROUPS = [
  ['sp500_comm', 'Communication Services'],
  ['sp500_discretionary', 'Consumer Discretionary'],
  ['sp500_staples', 'Consumer Staples'],
  ['sp500_energy', 'Energy'],
  ['sp500_financials', 'Financials'],
  ['sp500_health', 'Health Care'],
  ['sp500_industrials', 'Industrials'],
  ['sp500_tech', 'Information Technology'],
  ['sp500_materials', 'Materials'],
  ['sp500_real_estate', 'Real Estate'],
  ['sp500_utilities', 'Utilities'],
] as const;

/** Every built-in group's id, in the order pickers show them. */
export const STOCK_GROUP_IDS = [
  'sp500',
  'ndx',
  'dji',
  'sp400',
  'sp600',
  'r1000',
  'r2000',
  ...SP500_SECTOR_GROUPS.map(([id]) => id),
] as const;
export type StockGroupId = (typeof STOCK_GROUP_IDS)[number];

export interface StockGroup {
  id: StockGroupId;
  /** "Nasdaq 100", "S&P 500 · Energy". */
  label: string;
  /** Where the list comes from, for the screen's footnote. */
  source: string;
  /** The day the list was last refreshed ('' before its first refresh). */
  asOf: string;
  /** Pickers put groups under these headings. */
  kind: 'index' | 'sector';
  members: ReadonlySet<string>;
}

type Members = readonly (readonly [string, string])[];

const symbols = (list: Members) => new Set(list.map(([s]) => s));

const SP500_SOURCE =
  'github.com/datasets/s-and-p-500-companies (Wikipedia, "List of S&P 500 companies")';

const INDEXES: readonly StockGroup[] = [
  {
    id: 'sp500',
    label: 'S&P 500',
    source: SP500_SOURCE,
    asOf: SP500_AS_OF,
    kind: 'index',
    members: symbols(SP500_MEMBERS),
  },
  {
    id: 'ndx',
    label: 'Nasdaq 100',
    source: NDX_SOURCE,
    asOf: NDX_AS_OF,
    kind: 'index',
    members: symbols(NDX_MEMBERS),
  },
  {
    id: 'dji',
    label: 'Dow 30',
    source: DJI_SOURCE,
    asOf: DJI_AS_OF,
    kind: 'index',
    members: symbols(DJI_MEMBERS),
  },
  {
    id: 'sp400',
    label: 'S&P MidCap 400',
    source: SP400_SOURCE,
    asOf: SP400_AS_OF,
    kind: 'index',
    members: symbols(SP400_MEMBERS),
  },
  {
    id: 'sp600',
    label: 'S&P SmallCap 600',
    source: SP600_SOURCE,
    asOf: SP600_AS_OF,
    kind: 'index',
    members: symbols(SP600_MEMBERS),
  },
  {
    id: 'r1000',
    label: 'Russell 1000',
    source: R1000_SOURCE,
    asOf: R1000_AS_OF,
    kind: 'index',
    members: symbols(R1000_MEMBERS),
  },
  {
    id: 'r2000',
    label: 'Russell 2000',
    source: R2000_SOURCE,
    asOf: R2000_AS_OF,
    kind: 'index',
    members: symbols(R2000_MEMBERS),
  },
];

const SECTORS: readonly StockGroup[] = SP500_SECTOR_GROUPS.map(([id, sector]) => ({
  id,
  label: `S&P 500 · ${sector}`,
  source: SP500_SOURCE,
  asOf: SP500_AS_OF,
  kind: 'sector' as const,
  members: new Set(SP500_MEMBERS.filter(([, s]) => s === sector).map(([s]) => s)),
}));

/** Every built-in group, in STOCK_GROUP_IDS order. */
export const STOCK_GROUPS: readonly StockGroup[] = [...INDEXES, ...SECTORS];

/** The groups pickers offer: those whose list has been loaded at least once. */
export const AVAILABLE_STOCK_GROUPS: readonly StockGroup[] = STOCK_GROUPS.filter(
  (g) => g.members.size > 0,
);

const BY_ID = new Map(STOCK_GROUPS.map((g) => [g.id, g]));

export function isStockGroupId(value: unknown): value is StockGroupId {
  return typeof value === 'string' && BY_ID.has(value as StockGroupId);
}

export function stockGroup(id: StockGroupId): StockGroup {
  const group = BY_ID.get(id);
  if (!group) throw new Error(`Unknown stock group ${id}`);
  return group;
}

/** A group's members, sorted. */
export function stockGroupSymbols(id: StockGroupId): string[] {
  return [...stockGroup(id).members].sort();
}

/**
 * A stock's sector, from the first list that gives one: the S&P lists' GICS
 * sectors first, then the Nasdaq 100's, then the Russell ETFs' holdings.
 */
export const STOCK_SECTORS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const list of [
    SP500_MEMBERS,
    SP400_MEMBERS,
    SP600_MEMBERS,
    NDX_MEMBERS,
    R1000_MEMBERS,
    R2000_MEMBERS,
  ])
    for (const [symbol, sector] of list) if (sector && !map.has(symbol)) map.set(symbol, sector);
  return map;
})();
