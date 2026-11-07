/**
 * The three SPY strategies Yong keeps in Strategy Lab (Trend — SPY SMA200,
 * Mean Reversion — SPY RSI-2, Breakout — SPY Donchian 20/10), rebuilt from
 * their names as regression fixtures for v1.2: whatever the builder gains,
 * these must back test exactly as before. Not exported from the package.
 */
import {
  createDefinition,
  sequentialIds,
  type Bar,
  type Comparison,
  type Expr,
  type IndicatorExpr,
  type MarketExpr,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { dailyBars, type Row } from '../test-utils';

export const SPY = '00000000-0000-4000-8000-0000000005b1';
export const QQQ = '00000000-0000-4000-8000-0000000005b2';
export const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const market = (field: MarketExpr['field'] = 'close', offset = 0): MarketExpr => ({
  kind: 'market',
  id: id('m'),
  instrumentId: SPY,
  field,
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset,
});

const indicator = (
  name: string,
  params: IndicatorExpr['params'],
  field: IndicatorExpr['field'] = 'close',
  offset = 0,
): IndicatorExpr => ({
  kind: 'indicator',
  id: id('i'),
  name,
  params,
  instrumentId: SPY,
  field,
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset,
});

const constant = (value: string): Expr => ({ kind: 'constant', id: id('c'), value });

const cmp = (left: Expr, operator: Comparison['operator'], right: Expr): Comparison => ({
  kind: 'comparison',
  id: id('cmp'),
  left,
  operator,
  right,
});

const order = (legId: string, side: PlannedOrder['side']): PlannedOrder => ({
  id: legId,
  legLabel: legId,
  instrumentId: SPY,
  accountId: ACCOUNT,
  side,
  quantity:
    side === 'buy'
      ? { type: 'pct_equity', value: '20', rounding: 'down' }
      : { type: 'units', value: '1', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  extendedHours: false,
  timing: { mode: 'immediate' },
  timingOnly: false,
});

function build(entry: Comparison, exit: Comparison): StrategyDefinition {
  const def = createDefinition(sequentialIds('g'));
  def.entry.condition.children = [entry];
  def.entry.orders = [order('buy-spy', 'buy')];
  def.exit.condition.children = [exit];
  def.exit.orders = [order('sell-spy', 'close')];
  def.risk = {
    ...def.risk,
    maxOrderNotional: '50000',
    maxStrategyExposure: '50000',
    dailyLossLimit: '5000',
  };
  return def;
}

/** Trend — SPY SMA200: hold while the close is above its 200-day average. */
export const trendSma200 = () =>
  build(
    cmp(market(), 'crosses_above', indicator('SMA', { period: 200 })),
    cmp(market(), 'crosses_below', indicator('SMA', { period: 200 })),
  );

/** Mean Reversion — SPY RSI-2: buy a 2-day RSI under 10, sell once the close is above SMA(5). */
export const meanReversionRsi2 = () =>
  build(
    cmp(indicator('RSI', { period: 2 }), 'lt', constant('10')),
    cmp(market(), 'gt', indicator('SMA', { period: 5 })),
  );

/** Breakout — SPY Donchian 20/10, built the way the v1.1 builder allowed. */
export const breakoutDonchian = () =>
  build(
    cmp(market(), 'gt', indicator('HIGHEST', { period: 20 }, 'high')),
    cmp(market(), 'lt', indicator('LOWEST', { period: 10 }, 'low')),
  );

/**
 * The same breakout as the v1.2 builder builds it (item 7): Highest and Lowest
 * one bar back, so the window is the 20 (10) bars before the bar checked.
 */
export const breakoutDonchianPriorBars = () =>
  build(
    cmp(market(), 'gt', indicator('HIGHEST', { period: 20 }, 'high', 1)),
    cmp(market(), 'lt', indicator('LOWEST', { period: 10 }, 'low', 1)),
  );

/**
 * Design v1.2 item 8: a long 20-day breakout and a short 20-day breakdown on
 * SPY in one strategy, each with its matching 10-day exit.
 */
export function longShortBreakout(): StrategyDefinition {
  const def = build(
    cmp(market(), 'gt', indicator('HIGHEST', { period: 20 }, 'high', 1)),
    cmp(market(), 'lt', indicator('LOWEST', { period: 10 }, 'low', 1)),
  );
  def.entry.direction = 'long';
  const short = build(
    cmp(market(), 'lt', indicator('LOWEST', { period: 20 }, 'low', 1)),
    cmp(market(), 'gt', indicator('HIGHEST', { period: 10 }, 'high', 1)),
  );
  const shortLeg = { ...order('short-spy', 'sell_short'), legLabel: 'Short SPY' };
  shortLeg.quantity = { type: 'pct_equity', value: '20', rounding: 'down' };
  def.groups = [
    {
      id: 'short-group',
      label: 'Short breakdown',
      entry: { ...short.entry, direction: 'short', orders: [shortLeg] },
      exit: { ...short.exit, orders: [{ ...order('cover-spy', 'close'), legLabel: 'Cover SPY' }] },
    },
  ];
  return def;
}

/** A deterministic SPY-like random walk: ~2.5 years of daily bars from 2023-01-03. */
export function spyBars(count = 640, seed = 7): Bar[] {
  let s = seed;
  const rand = () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  const rows: Row[] = [];
  let price = 380;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 22) * 0.006 + 0.0003;
    const move = (rand() - 0.5) * 0.024 + drift;
    const open = price * (1 + (rand() - 0.5) * 0.006);
    const close = open * (1 + move);
    const high = Math.max(open, close) * (1 + rand() * 0.006);
    const low = Math.min(open, close) * (1 - rand() * 0.006);
    const r = (x: number) => Math.round(x * 100) / 100;
    rows.push([r(open), r(high), r(low), r(close), 50_000_000 + Math.round(rand() * 1e7)]);
    price = close;
  }
  return dailyBars('2023-01-03', rows);
}

export const spyCloses = (bars: readonly Bar[]) => bars.map((b) => new Decimal(b.close));

/** Two Entry legs that fire together, as every v1.1 multi-leg strategy does. */
export function twoLegs(): StrategyDefinition {
  const def = trendSma200();
  const qqq = (o: PlannedOrder, legId: string): PlannedOrder => ({
    ...o,
    id: legId,
    legLabel: legId,
    instrumentId: QQQ,
  });
  def.entry.orders = [...def.entry.orders, qqq(order('x', 'buy'), 'buy-qqq')];
  def.exit.orders = [...def.exit.orders, qqq(order('y', 'close'), 'sell-qqq')];
  return def;
}
