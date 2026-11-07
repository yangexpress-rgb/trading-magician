import { createHash } from 'node:crypto';
import {
  BrokerUnavailableError,
  CBOE_OPTIONS_URL,
  cboeOptionsPath,
  CboeOptionsFormatError,
  parseCboeOptions,
  type CboeChain,
} from '@tm/domain';

/**
 * CBOE's delayed-quotes CDN as the options source (options data brief v2
 * §1): keyless, one GET per underlying, about 15 minutes delayed. The folder
 * is configuration (`CBOE_OPTIONS_URL`). Each request has a 20-second timeout
 * and two retries (§5.1).
 */

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class CboeOptionsUnavailableError extends BrokerUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'CboeOptionsUnavailableError';
  }
}

export interface FetchedChain {
  chain: CboeChain;
  /** `cboe-<digest of the file>`. */
  dataVersion: string;
}

export interface ChainSource {
  /** Which feed the rows come from, stored on every row. */
  feed: 'cboe' | 'opra';
  chain(symbol: string): Promise<FetchedChain>;
}

export interface CboeOptionsOptions {
  fetch?: Fetch | undefined;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  retries?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export function cboeOptionsSource(options: CboeOptionsOptions = {}): ChainSource {
  const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const base = (options.baseUrl ?? CBOE_OPTIONS_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function once(symbol: string): Promise<FetchedChain> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${cboeOptionsPath(symbol)}`, {
        headers: { accept: 'application/json', 'user-agent': 'TradingMagician/1.0' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CboeOptionsUnavailableError(`CBOE could not be reached for ${symbol}`);
    }
    if (res.status === 403 || res.status === 404)
      throw new CboeOptionsFormatError(`CBOE has no options file for ${symbol}`);
    if (!res.ok) throw new CboeOptionsUnavailableError(`CBOE answered ${res.status} for ${symbol}`);
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CboeOptionsFormatError(`CBOE's ${symbol} options file is not JSON`);
    }
    const chain = parseCboeOptions(json);
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
    return { chain, dataVersion: `cboe-${digest}` };
  }

  return {
    feed: 'cboe',
    async chain(symbol) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(symbol);
        } catch (e) {
          if (!(e instanceof CboeOptionsUnavailableError) || attempt >= retries) throw e;
          await sleep(2000 * 2 ** attempt);
        }
      }
    },
  };
}
