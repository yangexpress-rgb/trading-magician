import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  DEFAULT_TRIGGER,
  regularSession,
  sequentialIds,
  tradingDays,
  type Bar,
  type Comparison,
  type ConditionGroup,
  type Expr,
  type IndicatorExpr,
  type MarketExpr,
  type MetricExpr,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { behaviour } from './corpus-codec';
import { seriesKey, type InstrumentRef, type LoadedData } from './data';
import { simulate } from './engine';
import { spyBars, SPY, trendSma200 } from './fixtures/spy-strategies';
import type { BacktestResult } from './results';
import { inputs, loaded } from './test-utils';

/**
 * Options trading brief v0.2, acceptance check A1 (ADR 0123): three reference
 * equity back tests, one single-asset strategy, one group strategy and one
 * intraday strategy, recorded on main 576f055 before any options code was
 * written. With OPTIONS_TRADING_ENABLED off (and with it on, since none of
 * these strategies has an options leg) each must re-run to the same headline
 * figures and the same behaviour fingerprint after every options phase. This
 * file is never edited by an options phase except to add a phase's name below.
 */

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
let seq = 0;
const nid = (p: string) => `${p}${++seq}`;

const market = (
  instrumentId: string,
  field: MarketExpr['field'] = 'close',
  interval: MarketExpr['interval'] = '1d',
): MarketExpr => ({
  kind: 'market',
  id: nid('m'),
  instrumentId,
  field,
  interval,
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});
const indicator = (
  instrumentId: string,
  name: string,
  params: IndicatorExpr['params'],
): IndicatorExpr => ({ ...market(instrumentId), kind: 'indicator', name, params });
const constant = (value: string): Expr => ({ kind: 'constant', id: nid('c'), value });
const cmp = (left: Expr, operator: Comparison['operator'], right: Expr): Comparison => ({
  kind: 'comparison',
  id: nid('cmp'),
  left,
  operator,
  right,
});
const all = (...children: Comparison[]): ConditionGroup => ({
  kind: 'group',
  id: nid('g'),
  op: 'and',
  negate: false,
  children,
});
const leg = (
  id: string,
  instrumentId: string,
  partial: Partial<PlannedOrder> = {},
): PlannedOrder => ({
  id,
  legLabel: id,
  instrumentId,
  accountId: ACCOUNT,
  side: 'buy',
  quantity: { type: 'pct_equity', value: '90', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  timing: { mode: 'immediate' },
  ...partial,
});

const headline = (r: BacktestResult) => ({
  finalEquity: r.metrics.finalEquity,
  netReturnPct: r.metrics.netReturnPct,
  maxDrawdownPct: r.metrics.maxDrawdownPct,
  closedCycles: r.metrics.closedCycles,
  orders: r.metrics.orders,
  fills: r.metrics.fills,
  trades: r.trades.length,
  fingerprint: behaviour(r),
});

// 1. Single asset: Trend — SPY SMA200 (the regression fixture).
function singleAsset() {
  return simulate({
    definition: trendSma200(),
    instruments: new Map([[SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }]]),
    inputs: inputs('2023-11-01', '2025-06-30'),
    data: loaded({ [SPY]: spyBars() }),
  });
}

// 2. Group: top 3 of 9 sector ETFs by 6-month return, above their 200-day SMA.
const SECTORS = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'];
const sectorIds = SECTORS.map((_, i) => uuid(0x100 + i));
function group() {
  const def = createDefinition(sequentialIds('a1g'));
  delete def.risk.trailingStopPct;
  def.entry.trigger = { ...DEFAULT_TRIGGER };
  def.exit.trigger = { ...DEFAULT_TRIGGER };
  def.risk = {
    ...def.risk,
    maxOrderNotional: '1000000',
    maxStrategyExposure: '1000000',
    maxActiveOrders: 50,
    dailyLossLimit: '50000',
    priceCollarPct: '20',
  };
  def.trade = {
    kind: 'group',
    universe: { type: 'list', instrumentIds: sectorIds },
    ranking: {
      metric: 'return',
      params: { lookbackMonths: '6', skipMonths: '0' },
      direction: 'desc',
      count: { type: 'fixed', value: 3 },
    },
    splitTotal: true,
    filter: all(
      cmp(
        market(CONTEXT_INSTRUMENT_ID),
        'gt',
        indicator(CONTEXT_INSTRUMENT_ID, 'SMA', { period: 200 }),
      ),
    ),
  };
  def.entry.orders = [leg('buy-each', CONTEXT_INSTRUMENT_ID)];
  def.exit.orders = [leg('close-each', CONTEXT_INSTRUMENT_ID, { side: 'close' })];
  def.exit.rules = [{ kind: 'leftGroup', id: 'left' }];
  return simulate({
    definition: def,
    instruments: new Map<string, InstrumentRef>(
      SECTORS.map((s, i) => [
        sectorIds[i] as string,
        { symbol: s, assetClass: 'etf', lotSize: '1' },
      ]),
    ),
    inputs: inputs('2023-06-01', '2025-06-30'),
    data: loaded(
      Object.fromEntries(sectorIds.map((id, i) => [id, spyBars(900, 101 + i * 17) as Bar[]])),
    ),
    members: sectorIds,
  });
}

// 3. Intraday: opening-range breakout on 5-minute bars, flat at session end.
const STOCK = uuid(0xa1);
const FIVE = 5 * 60_000;
function sessionBars(date: string, k: number): Bar[] {
  const session = regularSession(date);
  if (!session) throw new Error(date);
  const open = Date.parse(session.open);
  const n = (Date.parse(session.close) - open) / FIVE;
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    // A deterministic wave whose phase moves each day: some days break out, some don't.
    const p = 100 + k * 0.7 + 2 * Math.sin((i + k * 11) / 9) + i / (20 + k);
    const start = open + i * FIVE;
    out.push({
      start: new Date(start).toISOString(),
      end: new Date(start + FIVE).toISOString(),
      open: new Decimal(p.toFixed(2)),
      high: new Decimal((p + 0.4).toFixed(2)),
      low: new Decimal((p - 0.4).toFixed(2)),
      close: new Decimal((p + 0.1).toFixed(2)),
      volume: new Decimal(1000 + i),
    });
  }
  return out;
}
function intraday() {
  const days = tradingDays('2025-03-03', '2025-03-14');
  const bars = days.flatMap((d, k) => sessionBars(d, k));
  const close5m = market(STOCK, 'close', '5m');
  const orHigh: MetricExpr = {
    kind: 'metric',
    id: nid('s'),
    metric: 'session.opening_high',
    params: { rangeMinutes: 30 },
    instrumentId: STOCK,
  };
  const def: StrategyDefinition = createDefinition(sequentialIds('a1i'));
  delete def.risk.trailingStopPct;
  def.entry.condition.children = [cmp(close5m, 'gt', orHigh)];
  def.entry.trigger = { mode: 'on_transition', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = [
    leg('e', STOCK, { quantity: { type: 'units', value: '50', rounding: 'down' } }),
  ];
  def.exit.condition.children = [];
  def.exit.orders = [leg('x', STOCK, { side: 'close' })];
  def.execution = { ...def.execution, flattenAtSessionEnd: true };
  const data: LoadedData = {
    series: new Map([
      [
        seriesKey({
          instrumentId: STOCK,
          interval: '5m',
          adjustment: 'split_and_dividend',
          session: 'regular',
        }),
        bars,
      ],
    ]),
    dataVersions: ['test@1'],
    warnings: [],
  };
  return simulate({
    definition: def,
    instruments: new Map([[STOCK, { symbol: 'DEMO-I', assetClass: 'stock', lotSize: '1' }]]),
    inputs: inputs('2025-03-03', '2025-03-14', { interval: '5m' }),
    data,
  });
}

/** Recorded on main 576f055 before any options code (ADR 0123 §A1). Phases checked: O0. */
const RECORDED = {
  single: {
    finalEquity: '107423.48',
    netReturnPct: '7.42',
    maxDrawdownPct: '5.68',
    closedCycles: 6,
    orders: 13,
    fills: 13,
    trades: 7,
    fingerprint: '359f3c8d617a2e6e',
  },
  group: {
    finalEquity: '121973.27',
    netReturnPct: '21.97',
    maxDrawdownPct: '16.85',
    closedCycles: 72,
    orders: 147,
    fills: 147,
    trades: 75,
    fingerprint: 'c7b22c401990fa85',
  },
  intraday: {
    finalEquity: '100992.83',
    netReturnPct: '0.99',
    maxDrawdownPct: '0.16',
    closedCycles: 10,
    orders: 20,
    fills: 20,
    trades: 10,
    fingerprint: 'cf4525b1524509b4',
  },
};

describe('A1 reference equity back tests (options brief v0.2, ADR 0123)', () => {
  it('single asset: Trend — SPY SMA200', () => {
    expect(headline(singleAsset())).toEqual(RECORDED.single);
  });
  it('group: top 3 of 9 sector ETFs', () => {
    expect(headline(group())).toEqual(RECORDED.group);
  });
  it('intraday: opening-range breakout on 5-minute bars', () => {
    expect(headline(intraday())).toEqual(RECORDED.intraday);
  });
});
