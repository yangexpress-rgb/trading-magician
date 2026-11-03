import { SP500_AS_OF, SP500_MEMBERS } from './sp500-members';

/**
 * Which stocks the screener calls the S&P 500 (ADR 0030). Alpaca does not
 * say which index a stock is in, so the member list ships with the app and
 * is refreshed with `pnpm --filter @tm/domain sp500:update`; the screen says
 * how old it is.
 */
export const SP500_SECTORS: ReadonlyMap<string, string> = new Map(SP500_MEMBERS);

export { SP500_AS_OF };

export function isSp500(symbol: string): boolean {
  return SP500_SECTORS.has(symbol);
}
