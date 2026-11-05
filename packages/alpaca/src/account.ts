import type { BrokerCapabilities } from '@tm/domain';
import { AlpacaRequestError, type AlpacaClient } from './client';
import type { AlpacaAccount, AlpacaAsset } from './types';

/**
 * Capability discovery (§9.3, ADR 0017): what an Alpaca paper account can do,
 * read from the account itself where Alpaca says, and from Alpaca's documented
 * order rules otherwise.
 */

export interface DiscoveredAccount {
  /** Alpaca's account id; stored, never shown in full. */
  externalId: string;
  /** The account number with all but the last four characters masked. */
  displayId: string;
  environment: 'paper';
  currency: string;
  status: string;
  /** Trading is blocked by Alpaca (for example, a restricted account). */
  tradingBlocked: boolean;
  assetClasses: string[];
  capabilities: BrokerCapabilities;
}

export function maskAccountNumber(value: string): string {
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

export function alpacaCapabilities(account: Pick<AlpacaAccount, 'shorting_enabled'>) {
  const capabilities: BrokerCapabilities = {
    orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
    timeInForce: ['day', 'gtc', 'ioc', 'fok'],
    // Alpaca takes extended-hours orders as day limit orders only; the adapter checks that.
    extendedHours: true,
    // Alpaca's fractional orders are market or day orders on some assets only, so not offered yet.
    fractionalQuantities: false,
    shortSelling: account.shorting_enabled,
    atomicMultiLeg: false,
  };
  return capabilities;
}

export async function discoverAlpacaAccount(client: AlpacaClient): Promise<DiscoveredAccount> {
  const account = await client.trading<AlpacaAccount>('GET', '/v2/account');
  return {
    externalId: account.id,
    displayId: maskAccountNumber(account.account_number),
    environment: 'paper',
    currency: account.currency,
    status: account.status,
    tradingBlocked: account.trading_blocked || account.account_blocked,
    assetClasses: ['stock', 'etf'],
    capabilities: alpacaCapabilities(account),
  };
}

export interface DiscoveredInstrument {
  symbol: string;
  displayName: string;
  assetClass: 'stock' | 'etf';
  /** Alpaca's listing exchange, used as the venue. */
  venue: string;
  providerId: string;
  tradable: boolean;
  shortable: boolean;
}

/** Alpaca does not mark funds, so the name decides; routes usually treat both alike. */
const FUND_NAME = /\bET[FN]s?\b|\bFund\b|\bTrust,? Series\b/i;

function toDiscovered(asset: AlpacaAsset): DiscoveredInstrument {
  return {
    symbol: asset.symbol,
    displayName: asset.name.slice(0, 200),
    assetClass: FUND_NAME.test(asset.name) ? 'etf' : 'stock',
    venue: asset.exchange,
    providerId: asset.id,
    tradable: asset.tradable,
    shortable: asset.shortable,
  };
}

/** Every active US stock and ETF Alpaca lists (about 12,000; a few MB). */
export async function listAlpacaAssets(client: AlpacaClient): Promise<DiscoveredInstrument[]> {
  const assets = await client.trading<AlpacaAsset[]>('GET', '/v2/assets', {
    query: { status: 'active', asset_class: 'us_equity' },
  });
  return assets
    .filter((a) => a.class === 'us_equity' && a.status === 'active' && SYMBOL.test(a.symbol))
    .map(toDiscovered);
}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const NAME_NOISE =
  /\b(inc|corp|corporation|co|company|ltd|plc|holdings?|group|common stock|class [a-z]|the)\b\.?/gi;
const simplify = (s: string) =>
  s
    .toLowerCase()
    .replace(NAME_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Ranks listed instruments against what a person typed: the exact symbol
 * first, then symbols starting with it, then names whose words start with
 * every word typed (so "cencora" finds "Cencora, Inc. Common Stock" and
 * "bank of america" finds "Bank of America Corporation").
 */
export function searchInstruments<T extends { symbol: string; displayName: string }>(
  listed: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim();
  if (!q) return [];
  const upper = q.toUpperCase();
  const words = simplify(q).split(' ').filter(Boolean);
  const scored: { item: T; score: number }[] = [];
  for (const item of listed) {
    let score = 0;
    if (item.symbol === upper) score = 100;
    else if (upper.length >= 2 && item.symbol.startsWith(upper)) score = 60 - item.symbol.length;
    if (words.length > 0) {
      const name = ` ${simplify(item.displayName)}`;
      if (words.every((w) => name.includes(` ${w}`))) {
        // A name that starts with the query beats one that merely contains it.
        const starts = name.startsWith(` ${words.join(' ')}`);
        score = Math.max(score, (starts ? 50 : 30) - Math.min(20, name.length / 10));
      }
    }
    if (score > 0) scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.symbol.localeCompare(b.item.symbol))
    .slice(0, limit)
    .map((s) => s.item);
}

/** Looks up a US stock or ETF by symbol. Undefined when Alpaca has no such active asset. */
export async function lookupAlpacaAsset(
  client: AlpacaClient,
  symbol: string,
): Promise<DiscoveredInstrument | undefined> {
  const wanted = symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(wanted)) return undefined;
  let asset: AlpacaAsset;
  try {
    asset = await client.trading<AlpacaAsset>('GET', `/v2/assets/${encodeURIComponent(wanted)}`);
  } catch (e) {
    if (e instanceof AlpacaRequestError && (e.status === 404 || e.status === 422)) return undefined;
    throw e;
  }
  if (asset.class !== 'us_equity' || asset.status !== 'active') return undefined;
  return toDiscovered(asset);
}
