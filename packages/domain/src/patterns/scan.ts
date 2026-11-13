import { z } from 'zod';
import { STOCK_GROUP_IDS, stockGroup, type StockGroupId } from '../market/stock-groups';
import {
  FACTOR_CATALOGUE_V1,
  FACTOR_CATEGORIES,
  FACTOR_CATEGORY_LABELS,
  factorSpec,
  type FactorCategory,
} from './factors';

/**
 * Pattern scans (pattern brief §6–§8, N262–N264): the scan config the web
 * app queues and the miner reads, and the plain-words text every page shows.
 */

export const DEFAULT_MAX_DEPTH = 3;
export const DEFAULT_MIN_SUPPORT = 40;
export const DEFAULT_DISCOVERY_SHARE = 0.7;
/** §7 verification gate constants, shown on the pages beside the numbers they judge. */
export const VERIFY = {
  holdoutMinN: 15,
  minLift: 1.25,
  fdrQ: 0.1,
  beamWidth: 200,
  finalists: 50,
  redundantShare: 0.8,
} as const;

export const patternUniverseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('group'), id: z.enum(STOCK_GROUP_IDS) }),
  z.object({ kind: z.literal('options') }),
]);
export type PatternUniverse = z.infer<typeof patternUniverseSchema>;

export const patternOutcomeSchema = z.object({
  direction: z.enum(['spike', 'plunge']),
  /** X, in percent: 8 is ±8%. */
  pct: z.number().min(0.5).max(100),
  /** H, in trading days. */
  horizon: z.number().int().min(1).max(126),
});
export type PatternOutcome = z.infer<typeof patternOutcomeSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** What the person picks in the New scan form. */
export const patternScanInputSchema = z.object({
  universe: patternUniverseSchema,
  outcome: patternOutcomeSchema,
  categories: z.array(z.enum(FACTOR_CATEGORIES)).min(1),
  maxDepth: z.number().int().min(2).max(4).default(DEFAULT_MAX_DEPTH),
  minSupport: z.number().int().min(5).max(10_000).default(DEFAULT_MIN_SUPPORT),
  range: z.object({ from: isoDate.optional(), to: isoDate.optional() }).default({}),
  split: z
    .object({ discovery: z.number().min(0.5).max(0.9) })
    .default({ discovery: DEFAULT_DISCOVERY_SHARE }),
});
export type PatternScanInput = z.infer<typeof patternScanInputSchema>;

/** The stored config: the input plus what the miner needs resolved (members, the catalogue). */
export interface PatternScanConfig extends PatternScanInput {
  memberIds: string[];
  factors: { id: string; category: FactorCategory; modes: string[] }[];
  catalogueVersion: number;
}

/** The catalogue entries a scan of these categories reads. */
export const scanFactors = (categories: readonly FactorCategory[]) =>
  FACTOR_CATALOGUE_V1.filter((f) => categories.includes(f.category)).map((f) => ({
    id: f.id,
    category: f.category,
    modes: [...f.modes],
  }));

export function universeLabel(u: PatternUniverse): string {
  return u.kind === 'options' ? 'Options universe' : stockGroup(u.id as StockGroupId).label;
}

const pct = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)}%`;

export function outcomeWords(o: PatternOutcome): string {
  return o.direction === 'spike'
    ? `ran up at least +${pct(o.pct)} within the next ${o.horizon} trading days`
    : `fell at least −${pct(o.pct)} within the next ${o.horizon} trading days`;
}

export function outcomeShort(o: PatternOutcome): string {
  return `${o.direction === 'spike' ? 'Spike' : 'Plunge'} ${o.direction === 'spike' ? '+' : '−'}${pct(o.pct)} / ${o.horizon}d`;
}

/** The scan config in plain words, for the scan list (brief §6). */
export function scanSummary(input: PatternScanInput): string {
  const cats = input.categories.map((c) => FACTOR_CATEGORY_LABELS[c].toLowerCase()).join(', ');
  const range =
    input.range.from || input.range.to
      ? `, ${input.range.from ?? 'start of data'} to ${input.range.to ?? 'latest'}`
      : ', full available range';
  return `${universeLabel(input.universe)}: ${outcomeShort(input.outcome)}; ${cats}; up to ${input.maxDepth} conditions, at least ${input.minSupport} discovery occurrences${range}.`;
}

export interface PatternAtom {
  factor: string;
  mode: 'cross' | 'own';
  bucket: 'top' | 'bottom' | 'high' | 'low';
}

export function atomWords(a: PatternAtom): string {
  const label = factorSpec(a.factor)?.label ?? a.factor;
  switch (a.bucket) {
    case 'top':
      return `${label} is in the top quintile of the universe`;
    case 'bottom':
      return `${label} is in the bottom quintile of the universe`;
    case 'high':
      return `${label} is at or above the 90th percentile of its own past year`;
    case 'low':
      return `${label} is at or below the 10th percentile of its own past year`;
  }
}

/** A rule in plain words: "When A AND B AND C". */
export function ruleWords(rule: readonly PatternAtom[]): string {
  return `When ${rule.map(atomWords).join(' AND ')}`;
}

export interface PatternWindowStats {
  n: number;
  hits: number;
  rate: number;
  baseRate: number;
  lift: number;
  wilsonLower: number;
  pValue: number | null;
}

export interface PatternStats {
  discovery: PatternWindowStats;
  holdout: PatternWindowStats;
  level: number;
  failedChecks: string[];
}

export type PatternChip = 'Candidate' | 'Verified' | 'Holding' | 'Weakening' | 'Broken';

/** The status chip (§8): decay's state once a Verified pattern has been re-scored. */
export function patternChip(
  status: 'candidate' | 'verified',
  decay: 'holding' | 'weakening' | 'broken' | null,
): PatternChip {
  if (status === 'candidate') return 'Candidate';
  if (decay === 'holding') return 'Holding';
  if (decay === 'weakening') return 'Weakening';
  if (decay === 'broken') return 'Broken';
  return 'Verified';
}

/** "41 of 55 (75%)": the holdout figure every list shows (§7: never the discovery rate). */
export function hitRateWords(s: Pick<PatternWindowStats, 'n' | 'hits' | 'rate'>): string {
  return s.n === 0 ? 'no occurrences' : `${s.hits} of ${s.n} (${Math.round(s.rate * 100)}%)`;
}

/** A sensible theory name for a promoted pattern (§9). */
export function promotedName(rule: readonly PatternAtom[], max = 120): string {
  const words = `Pattern: ${rule.map((a) => atomWords(a)).join(' AND ')}`;
  if (words.length <= max) return words;
  return `${words.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
}

/** One occurrence's daily close-to-close returns around it, by offset in trading days. */
export interface EventPath {
  /** close_ret of each trading day from `offset` −before+1 to +after, keyed by offset. */
  returns: ReadonlyMap<number, number>;
}

export interface EventStudyPoint {
  offset: number;
  mean: number;
  se: number;
  n: number;
}

/**
 * The event study (§8): for each offset from −before to +after trading days,
 * the mean return from the occurrence day's close to that day's close, with
 * its standard error. An occurrence missing a day on the way counts for the
 * offsets before the gap only.
 */
export function eventStudy(
  paths: readonly EventPath[],
  before: number,
  after: number,
): EventStudyPoint[] {
  const out: EventStudyPoint[] = [];
  for (let k = -before; k <= after; k++) {
    const values: number[] = [];
    for (const p of paths) {
      let level = 1;
      let ok = true;
      if (k > 0) {
        for (let j = 1; j <= k; j++) {
          const r = p.returns.get(j);
          if (r === undefined) {
            ok = false;
            break;
          }
          level *= 1 + r;
        }
      } else if (k < 0) {
        // close(t+k) / close(t) = 1 / Π(1 + r) over days t+k+1 … t.
        let prod = 1;
        for (let j = k + 1; j <= 0; j++) {
          const r = p.returns.get(j);
          if (r === undefined) {
            ok = false;
            break;
          }
          prod *= 1 + r;
        }
        level = 1 / prod;
      }
      if (ok && Number.isFinite(level)) values.push(level - 1);
    }
    const n = values.length;
    const mean = n ? values.reduce((a, v) => a + v, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)) : 0;
    out.push({ offset: k, mean, se: n > 1 ? sd / Math.sqrt(n) : 0, n });
  }
  return out;
}
