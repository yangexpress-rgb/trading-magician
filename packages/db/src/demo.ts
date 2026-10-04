/**
 * Generic demo data. Seed data uses invented instruments only (Design v1.0 §21);
 * no real tickers, accounts or credentials.
 */

export const DEMO_VENUE = 'DEMO';

export const DEMO_INSTRUMENTS = [
  { symbol: 'DEMO-A', displayName: 'Demo Beverages A', assetClass: 'stock' },
  { symbol: 'DEMO-B', displayName: 'Demo Beverages B', assetClass: 'stock' },
  { symbol: 'DEMO-C', displayName: 'Demo Software C', assetClass: 'stock' },
  { symbol: 'DEMO-D', displayName: 'Demo Software D', assetClass: 'stock' },
  { symbol: 'DEMO-E', displayName: 'Demo Energy E', assetClass: 'stock' },
  { symbol: 'DEMO-IDX', displayName: 'Demo Broad Market ETF', assetClass: 'etf' },
  { symbol: 'DEMO-BND', displayName: 'Demo Bond ETF', assetClass: 'etf' },
] as const;

/** Phase 1 coverage confirmed 2026-10-04: US stocks and ETFs. */
export const DEMO_ASSET_CLASSES = ['stock', 'etf'] as const;

export const DEMO_ACCOUNT_CAPABILITIES = {
  assetClasses: [...DEMO_ASSET_CLASSES],
  orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  timeInForce: ['day', 'gtc', 'ioc', 'fok'],
  sides: ['buy', 'sell', 'sell_short', 'buy_to_cover'],
  extendedHours: true,
  shortSelling: true,
  fractionalQuantity: false,
  /** Multi-leg submission is never atomic on the demo broker (§6.7). */
  atomicMultiLeg: false,
} as const;

/** Placeholder plan until billing exists (Phase 6). Limits are data, not code (§4.3). */
export const DEV_PLAN = {
  code: 'dev',
  limits: {
    savedStrategies: 50,
    activeStrategies: 5,
    backtestRunsPerDay: 100,
    concurrentBacktests: 2,
    liveData: false,
    paperIntegrations: true,
    realIntegrations: false,
    connectedAccounts: 3,
  },
} as const;
