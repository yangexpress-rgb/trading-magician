/**
 * Builders shared by the back-test tests. Not exported from the package.
 */
import {
  createDefinition,
  regularSession,
  sequentialIds,
  tradingDays,
  type Bar,
  type Comparison,
  type Expr,
  type MarketExpr,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import type { BacktestResult } from './results';
import { seriesKey, type InstrumentRef, type LoadedData } from './data';
import { DEFAULT_BACKTEST_INPUTS, type BacktestInputs } from './inputs';

export const A = '00000000-0000-4000-8000-00000000000a';
export const B = '00000000-0000-4000-8000-00000000000b';
export const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

export const INSTRUMENTS = new Map<string, InstrumentRef>([
  [A, { symbol: 'DEMO-A', assetClass: 'stock', lotSize: '1' }],
  [B, { symbol: 'DEMO-B', assetClass: 'stock', lotSize: '1' }],
]);

/** [open, high, low, close] or [open, high, low, close, volume]. */
export type Row = readonly [number, number, number, number, number?];

/** Daily bars on consecutive NYSE trading days starting at `from`. */
export function dailyBars(from: string, rows: readonly Row[]): Bar[] {
  const days = tradingDays(from, '2030-12-31').slice(0, rows.length);
  return rows.map(([open, high, low, close, volume = 1_000_000], i) => {
    const session = regularSession(days[i] ?? '');
    if (!session) throw new Error('Ran out of trading days');
    return {
      start: session.open,
      end: session.close,
      open: new Decimal(open),
      high: new Decimal(high),
      low: new Decimal(low),
      close: new Decimal(close),
      volume: new Decimal(volume),
    };
  });
}

/** Flat bars at each close: open, high, low and close all equal. */
export const closes = (from: string, values: readonly number[]) =>
  dailyBars(
    from,
    values.map((v) => [v, v, v, v] as const),
  );

export function loaded(series: Record<string, Bar[]>): LoadedData {
  const map = new Map<string, Bar[]>();
  for (const [id, bars] of Object.entries(series)) {
    map.set(
      seriesKey({
        instrumentId: id,
        interval: '1d',
        adjustment: 'split_and_dividend',
        session: 'regular',
      }),
      bars,
    );
  }
  return { series: map, dataVersions: ['test@1'], warnings: [] };
}

export function inputs(
  from: string,
  to: string,
  patch: Partial<BacktestInputs> = {},
): BacktestInputs {
  return { ...DEFAULT_BACKTEST_INPUTS, from, to, ...patch };
}

let n = 0;
const uid = (p: string) => `${p}${++n}`;

export function close(instrumentId = A, offset = 0): MarketExpr {
  return {
    kind: 'market',
    id: uid('m'),
    instrumentId,
    field: 'close',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    offset,
  };
}

export const constant = (value: string): Expr => ({ kind: 'constant', id: uid('c'), value });

export function compare(left: Expr, operator: Comparison['operator'], right: Expr): Comparison {
  return { kind: 'comparison', id: uid('cmp'), left, operator, right };
}

export function leg(id: string, partial: Partial<PlannedOrder> = {}): PlannedOrder {
  return {
    id,
    legLabel: id,
    instrumentId: A,
    accountId: ACCOUNT,
    side: 'buy',
    quantity: { type: 'units', value: '10', rounding: 'down' },
    orderType: 'market',
    timeInForce: 'day',
    extendedHours: false,
    timing: { mode: 'immediate' },
    timingOnly: false,
    ...partial,
  };
}

/** A strategy that enters when `entry` holds and exits when `exit` holds. */
export function strategy(
  entry: Comparison,
  entryLegs: PlannedOrder[],
  exit: Comparison,
  exitLegs: PlannedOrder[],
): StrategyDefinition {
  const def = createDefinition(sequentialIds('g'));
  def.entry.condition.children = [entry];
  def.entry.orders = entryLegs;
  def.exit.condition.children = [exit];
  def.exit.orders = exitLegs;
  return def;
}

/**
 * A result's fingerprint over every field a v1.1 result had, for the
 * backward-compatibility checks (regression.test.ts).
 */
const V11_FIELDS = [
  'conditions',
  'orders',
  'symbols',
  'engineVersion',
  'dataVersions',
  'assumptions',
  'sharpeMethod',
  'metrics',
  'equity',
  'trades',
  'fills',
  'contributions',
  'warnings',
] as const;

export function fingerprint(r: BacktestResult): string {
  const picked = Object.fromEntries(V11_FIELDS.map((k) => [k, r[k]]));
  return createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 16);
}

