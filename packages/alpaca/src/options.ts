import type { OptionRight } from '@tm/domain';
import type { AlpacaClient } from './client';
import { withAlpacaRetries } from './market-data';

/**
 * Alpaca's option contracts and option bars (options data brief v2 §5.2):
 * the source of the history rebuild. Option bars are real trades back to
 * February 2024; the contracts list, including expired contracts, says which
 * symbols existed. Read only: the app never trades options.
 */

export interface AlpacaOptionContract {
  symbol: string;
  expiration_date: string;
  type: 'call' | 'put';
  strike_price: string;
  underlying_symbol: string;
  status?: string;
}

interface ContractsPage {
  option_contracts: AlpacaOptionContract[] | null;
  next_page_token?: string | null;
}

export interface OptionBar {
  /** Bar start (RFC 3339). */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Number of trades. */
  n: number;
  vw?: number;
}

interface OptionBarsPage {
  bars: Record<string, OptionBar[]> | null;
  next_page_token?: string | null;
}

export interface ContractQuery {
  underlying: string;
  expirationGte: string;
  expirationLte: string;
  strikeGte?: number | undefined;
  strikeLte?: number | undefined;
}

export interface OptionContractRef {
  symbol: string;
  expiry: string;
  right: OptionRight;
  strike: number;
}

const MAX_PAGES = 200;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Active and expired contracts of an underlying between two expiries. */
export async function fetchOptionContracts(
  client: AlpacaClient,
  query: ContractQuery,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<OptionContractRef[]> {
  const out: OptionContractRef[] = [];
  for (const status of ['inactive', 'active'] as const) {
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageToken = token;
      const result = await withAlpacaRetries(
        () =>
          client.trading<ContractsPage>('GET', '/v2/options/contracts', {
            query: {
              underlying_symbols: query.underlying,
              status,
              expiration_date_gte: query.expirationGte,
              expiration_date_lte: query.expirationLte,
              strike_price_gte: query.strikeGte,
              strike_price_lte: query.strikeLte,
              limit: 10_000,
              page_token: pageToken,
            },
          }),
        options.sleep ?? sleep,
      );
      for (const c of result.option_contracts ?? []) {
        const strike = Number(c.strike_price);
        if (!(strike > 0) || (c.type !== 'call' && c.type !== 'put')) continue;
        out.push({ symbol: c.symbol, expiry: c.expiration_date, right: c.type, strike });
      }
      if (!result.next_page_token) break;
      token = result.next_page_token;
    }
  }
  return out;
}

/** Daily bars of option contracts, up to 100 symbols a request, keyed by symbol. */
export async function fetchOptionBars(
  client: AlpacaClient,
  symbols: readonly string[],
  from: string,
  to: string,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<Map<string, OptionBar[]>> {
  const out = new Map<string, OptionBar[]>();
  for (let i = 0; i < symbols.length; i += 100) {
    const batch = symbols.slice(i, i + 100);
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const pageToken = token;
      const result = await withAlpacaRetries(
        () =>
          client.data<OptionBarsPage>('/v1beta1/options/bars', {
            symbols: batch.join(','),
            timeframe: '1Day',
            start: `${from}T00:00:00Z`,
            end: `${to}T23:59:59Z`,
            limit: 10_000,
            sort: 'asc',
            page_token: pageToken,
          }),
        options.sleep ?? sleep,
      );
      for (const [symbol, bars] of Object.entries(result.bars ?? {})) {
        const list = out.get(symbol) ?? [];
        list.push(...bars);
        out.set(symbol, list);
      }
      if (!result.next_page_token) break;
      token = result.next_page_token;
    }
  }
  return out;
}
