import { CONTEXT_INSTRUMENT_ID } from '../strategy/evaluate';
import { definitionExpressions } from '../strategy/selection';
import type { BarInterval } from '../strategy/catalog';
import type { ConditionGroup, PlannedOrder, StrategyDefinition } from '../strategy/schema';
import { describeCondition, type SymbolLookup } from '../strategy/text';
import type { MeasuredDuration } from './duration';
import { SHORT_DESCRIPTION_MAX, type RegisterLibraryEntryInput } from './entry';

/**
 * Strategy Lab numbering (ADR 0054, design v1.2 N98 to N106): every Lab
 * strategy is associated with exactly one Strategy Library record and shows
 * that record's number. A strategy saved with no link gets a record created
 * for it; this module derives that record from the strategy.
 */

/** Instrument asset classes as the instrument table stores them. */
export type LabAssetClass = 'stock' | 'etf' | 'option' | 'future' | 'forex' | 'crypto' | 'index';

/** Asset-class letters of convention v1 for the classes a strategy can trade. */
const CLASS_CODES: Record<Exclude<LabAssetClass, 'index'>, string> = {
  stock: 'S',
  etf: 'E',
  option: 'O',
  future: 'U',
  forex: 'F',
  crypto: 'C',
};

/** The tag every auto-created record carries, so it reads as a stub to complete. */
export const AUTO_CREATED_TAG = 'auto-created';
export const AUTO_CREATED_DATA_REQUIREMENTS =
  'Auto-created from Strategy Lab — complete in the Library.';
export const AUTO_CREATED_NOTE = 'Auto-created from Strategy Lab';
/** What the builder says while a draft has no Entry leg with an instrument (D3). */
export const NUMBER_PENDING_TEXT = 'Number assigned on first save with instruments.';

/**
 * Test scaffolding gets no number (brief O72, design O74): a strategy whose
 * name starts with "Fixture" is never auto-created or backfilled. It can still
 * be linked by hand.
 */
export function isFixtureName(name: string): boolean {
  return /^fixture\b/i.test(name.trim());
}

/** Every Entry leg of every entry group. */
function entryLegs(def: StrategyDefinition): PlannedOrder[] {
  return [def.entry, ...(def.groups ?? []).map((g) => g.entry)].flatMap((e) => e.orders);
}

/**
 * What the strategy trades: its Entry legs' instruments and a Selection
 * group's universe. `builtin` is a built-in universe (the S&P 500: stocks).
 */
export function tradedInstruments(def: StrategyDefinition): {
  instrumentIds: string[];
  builtin: 'sp500' | null;
} {
  const ids = new Set<string>();
  for (const o of entryLegs(def))
    if (o.instrumentId !== CONTEXT_INSTRUMENT_ID) ids.add(o.instrumentId);
  const universe = def.entry.kind === 'selection' ? def.entry.selection?.universe : undefined;
  if (universe?.type === 'list') for (const id of universe.instrumentIds) ids.add(id);
  return { instrumentIds: [...ids], builtin: universe?.type === 'builtin' ? universe.id : null };
}

/**
 * The asset-class letter (D4): one class takes its letter, more than one is
 * A (multi-asset). Watch-only indices are not traded and do not count.
 * Null while nothing tradable is known: no number is issued then (D3).
 */
export function deriveAssetClassCode(
  def: StrategyDefinition,
  classOf: (instrumentId: string) => LabAssetClass | undefined,
): string | null {
  const { instrumentIds, builtin } = tradedInstruments(def);
  const classes = new Set<string>();
  if (builtin) classes.add(CLASS_CODES.stock);
  for (const id of instrumentIds) {
    const c = classOf(id);
    if (c && c !== 'index') classes.add(CLASS_CODES[c]);
  }
  if (classes.size === 0) return null;
  const [only] = classes;
  return classes.size === 1 && only ? only : 'A';
}

const INTERVAL_CODE: Record<BarInterval, 'N' | 'H' | 'D' | 'W'> = {
  '1m': 'N',
  '5m': 'N',
  '15m': 'N',
  '30m': 'N',
  '1h': 'H',
  '4h': 'H',
  '1d': 'D',
  '1w': 'W',
};

/**
 * The timeframe letter, the decision timescale (D4, Library D4). A calendar
 * schedule wins over the bars (brief O71, design O73): month end M, quarter
 * end Q, year end Y, week W. Otherwise the bars the conditions read: all
 * minute bars N, all hourly H, all weekly W, all daily D. Mixed or none: D.
 */
export function deriveTimeframeCode(def: StrategyDefinition): string {
  switch (def.schedule?.frequency) {
    case 'monthEnd':
      return 'M';
    case 'quarterEnd':
      return 'Q';
    case 'yearEnd':
      return 'Y';
    case 'weekly':
      return 'W';
    default:
      break;
  }
  const codes = new Set<string>();
  for (const e of definitionExpressions(def)) {
    if (e.kind === 'market' || e.kind === 'indicator') codes.add(INTERVAL_CODE[e.interval]);
  }
  const [only] = codes;
  return codes.size === 1 && only ? only : 'D';
}

/** The record's letters, or null when no number can be issued yet (D3). */
export function deriveLibraryCodes(
  def: StrategyDefinition,
  classOf: (instrumentId: string) => LabAssetClass | undefined,
): { recordTypeCode: 'S'; timeframeCode: string; assetClassCode: string } | null {
  const assetClassCode = deriveAssetClassCode(def, classOf);
  if (!assetClassCode) return null;
  return { recordTypeCode: 'S', timeframeCode: deriveTimeframeCode(def), assetClassCode };
}

const DAILY: MeasuredDuration = { kind: 'every', value: 1, unit: 'days' };
const FREQUENCY: Record<string, MeasuredDuration> = {
  N: { kind: 'every', value: 1, unit: 'minutes' },
  H: { kind: 'every', value: 1, unit: 'hours' },
  D: { kind: 'every', value: 1, unit: 'days' },
  W: { kind: 'every', value: 1, unit: 'weeks' },
  M: { kind: 'every', value: 1, unit: 'months' },
  Q: { kind: 'every', value: 1, unit: 'quarters' },
  Y: { kind: 'every', value: 1, unit: 'years' },
};

const hasRules = (g: ConditionGroup | undefined) => !!g && g.children.length > 0;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** The "Reads as" lines of one Entry or Exit, as the builder shows them. */
function phaseProse(
  phase: { condition: ConditionGroup; orders: PlannedOrder[] },
  symbol: SymbolLookup,
  empty: string,
): string[] {
  const lines: string[] = [];
  if (hasRules(phase.condition)) lines.push(describeCondition(phase.condition, symbol));
  for (const o of phase.orders) {
    if (o.legCondition && hasRules(o.legCondition)) {
      const on =
        o.instrumentId === CONTEXT_INSTRUMENT_ID ? '' : ` (${symbol(o.instrumentId) ?? '?'})`;
      lines.push(`${o.legLabel}${on}: ${describeCondition(o.legCondition, symbol)}`);
    }
  }
  return lines.length ? lines : [empty];
}

export interface AutoCreateSource {
  strategyId: string;
  name: string;
  description: string;
  definition: StrategyDefinition;
  symbol: SymbolLookup;
  classOf: (instrumentId: string) => LabAssetClass | undefined;
}

/**
 * The Library record created for a strategy saved with no link (D3): name
 * from the strategy, entry and exit prose from its condition text, assets
 * from its instruments, tagged auto-created. Null while no number can be
 * issued (no Entry leg with an instrument yet).
 */
export function autoCreatedRecord(src: AutoCreateSource): RegisterLibraryEntryInput | null {
  const codes = deriveLibraryCodes(src.definition, src.classOf);
  if (!codes) return null;
  const def = src.definition;
  const groups = [
    { label: null as string | null, entry: def.entry, exit: def.exit },
    ...(def.groups ?? []).map((g) => ({
      label: g.label as string | null,
      entry: g.entry,
      exit: g.exit,
    })),
  ];
  const prose = (pick: 'entry' | 'exit') =>
    groups
      .flatMap((g) => {
        const lines = phaseProse(
          g[pick],
          src.symbol,
          pick === 'entry' ? 'No Entry condition yet.' : 'No Exit condition yet.',
        );
        return g.label ? [[`${g.label}:`, ...lines.map((l) => `- ${l}`)].join('\n')] : lines;
      })
      .join('\n\n');

  const { instrumentIds, builtin } = tradedInstruments(def);
  const symbols = instrumentIds
    .map((id) => src.symbol(id))
    .filter((s): s is string => !!s)
    .sort();
  const assets = [builtin ? 'S&P 500 members' : null, ...symbols].filter(Boolean).join(', ');
  const description = src.description.trim();
  const stub = `Auto-created from the Strategy Lab strategy “${src.name}”.`;

  return {
    ...codes,
    name: src.name,
    category: 'other',
    tags: [AUTO_CREATED_TAG],
    shortDescription: clip(description || stub, SHORT_DESCRIPTION_MAX),
    longDescription: description ? `${description}\n\n${stub}` : stub,
    assets: clip(assets || '—', 500),
    dataRequirements: AUTO_CREATED_DATA_REQUIREMENTS,
    entry: clip(prose('entry'), 10_000),
    exit: clip(prose('exit'), 10_000),
    frequency: FREQUENCY[codes.timeframeCode] ?? DAILY,
    turnaround: { kind: 'unknown' },
    builtStrategyId: src.strategyId,
  };
}
