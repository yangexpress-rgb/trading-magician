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
  /** The simulated broker has no extended session (ADR 0018). */
  extendedHours: false,
  shortSelling: true,
  fractionalQuantity: false,
  /** Multi-leg submission is never atomic on the demo broker (§6.7). */
  atomicMultiLeg: false,
  coverage: 'demo',
} as const;

/**
 * Whether the invented demo data is switched on (ADR 0039). It is off by
 * default: real deployments use real feeds only, with no demo instruments and
 * no demo feed. The automated tests turn it on (`DEMO_DATA=on`) so they can
 * run without any provider.
 *
 * Design v1.2 item 10: it is test data only, so `DEMO_DATA=on` is ignored on a
 * hosted deployment (Railway) or an app served anywhere but this machine.
 * Nothing can seed demo instruments into a real database.
 */
export function demoDataEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.DEMO_DATA !== 'on') return false;
  if (env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID)
    return false;
  return env.APP_URL === undefined || isLocalUrl(env.APP_URL);
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}
