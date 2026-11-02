/**
 * Builders shared by the strategy tests. Not exported from the package.
 */
import { createDefinition } from './defaults';
import { sequentialIds, type IdFactory } from './ids';
import type {
  Comparison,
  ConstantExpr,
  Expr,
  IndicatorExpr,
  MarketExpr,
  PositionExpr,
  PlannedOrder,
  StrategyDefinition,
} from './schema';
import type {
  AccountCapabilities,
  AccountInfo,
  InstrumentInfo,
  ValidationContext,
} from './validate';

export const STOCK_A = '00000000-0000-4000-8000-00000000000a';
export const STOCK_B = '00000000-0000-4000-8000-00000000000b';
export const UNKNOWN_INSTRUMENT = '00000000-0000-4000-8000-0000000000ff';
export const PAPER_ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
export const OTHER_ACCOUNT = '00000000-0000-4000-8000-0000000000a2';
export const NOW = new Date('2026-10-05T14:00:00Z');

export const CAPS: AccountCapabilities = {
  assetClasses: ['stock', 'etf'],
  orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  timeInForce: ['day', 'gtc', 'ioc', 'fok'],
  sides: ['buy', 'sell', 'sell_short', 'buy_to_cover'],
  extendedHours: true,
  shortSelling: true,
  fractionalQuantity: false,
  atomicMultiLeg: false,
};

export function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  const instruments = new Map<string, InstrumentInfo>([
    [STOCK_A, { symbol: 'DEMO-A', assetClass: 'stock', lotSize: '1' }],
    [STOCK_B, { symbol: 'DEMO-B', assetClass: 'stock', lotSize: '1' }],
  ]);
  const accounts = new Map<string, AccountInfo>([
    [PAPER_ACCOUNT, { nickname: 'Paper', mode: 'paper', isActive: true, capabilities: CAPS }],
  ]);
  return { instruments, accounts, hasFeed: () => true, now: NOW, ...overrides };
}

export const constant = (value: string, id = `c${value}`): ConstantExpr => ({
  kind: 'constant',
  id,
  value,
});

export function market(id: string, partial: Partial<MarketExpr> = {}): MarketExpr {
  return {
    kind: 'market',
    id,
    instrumentId: STOCK_A,
    field: 'close',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    offset: 0,
    ...partial,
  };
}

export function indicator(id: string, partial: Partial<IndicatorExpr> = {}): IndicatorExpr {
  return {
    kind: 'indicator',
    id,
    name: 'SMA',
    params: { period: 20 },
    instrumentId: STOCK_A,
    field: 'close',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    offset: 0,
    ...partial,
  };
}

export function position(id: string, partial: Partial<PositionExpr> = {}): PositionExpr {
  return {
    kind: 'position',
    id,
    instrumentId: STOCK_A,
    field: 'gain_pct',
    interval: '1d',
    adjustment: 'split_and_dividend',
    session: 'regular',
    ...partial,
  };
}

export function comparison(
  id: string,
  left: Expr,
  operator: Comparison['operator'],
  right?: Expr,
  upper?: Expr,
): Comparison {
  return {
    kind: 'comparison',
    id,
    left,
    operator,
    ...(right ? { right } : {}),
    ...(upper ? { upper } : {}),
  };
}

export function order(id: string, partial: Partial<PlannedOrder> = {}): PlannedOrder {
  return {
    id,
    legLabel: id,
    instrumentId: STOCK_A,
    accountId: PAPER_ACCOUNT,
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

/**
 * A complete strategy that passes validation: buy 10 DEMO-A when the close
 * crosses above its 20-day average; sell 10 when it closes below 95.
 */
export function validDefinition(ids: IdFactory = sequentialIds('g')): StrategyDefinition {
  const def = createDefinition(ids);
  def.entry.condition.children = [
    comparison('entry-cross', market('m1'), 'crosses_above', indicator('i1')),
  ];
  def.entry.orders = [order('buy-a')];
  def.exit.condition.children = [comparison('exit-below', market('m2'), 'lt', constant('95'))];
  def.exit.orders = [order('sell-a', { side: 'sell' })];
  return def;
}
