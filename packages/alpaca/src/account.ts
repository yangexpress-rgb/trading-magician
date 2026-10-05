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
