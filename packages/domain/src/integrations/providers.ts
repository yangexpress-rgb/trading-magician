/**
 * Providers the app can connect to (§9.2–9.3), and the credential fields each
 * one asks for. Paper endpoints only: live trading stays disabled (ADR 0002).
 */

export interface CredentialField {
  name: string;
  label: string;
  /** Shown under the field; never a real value. */
  help: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  /**
   * What a connection to this provider can be used for: prices (market
   * data), trading (broker), or company financials and profiles
   * (fundamentals, ADR 0031), which have no routes.
   */
  offers: readonly ('market_data' | 'broker' | 'fundamentals')[];
  /** Asset classes it can price or trade (US stocks and ETFs, and indices to watch). */
  assetClasses: readonly string[];
  /**
   * What a price feed is routed for when it is added (ADR 0038): bars and
   * live prices unless it says otherwise. CBOE's index history has daily
   * bars only, so it gets a bars route alone (v1.2 item 5).
   */
  dataTypes?: readonly ('bars' | 'quotes')[];
  /** 'demo' covers only the invented DEMO instruments; 'us' covers real US companies and venues. */
  coverage: 'demo' | 'us';
  /** Empty for providers that need no sign-in, like the built-in demo. */
  credentialFields: readonly CredentialField[];
}

export const PROVIDERS = {
  demo: {
    id: 'demo',
    name: 'Demo (built in)',
    offers: ['market_data', 'broker'],
    assetClasses: ['stock', 'etf'],
    coverage: 'demo',
    credentialFields: [],
  },
  alpaca: {
    id: 'alpaca',
    name: 'Alpaca',
    offers: ['market_data', 'broker'],
    assetClasses: ['stock', 'etf'],
    coverage: 'us',
    credentialFields: [
      {
        name: 'keyId',
        label: 'API key ID',
        help: 'From your Alpaca paper trading dashboard.',
      },
      {
        name: 'secretKey',
        label: 'Secret key',
        help: 'Shown once by Alpaca when you create the key.',
      },
    ],
  },
  custom_rest: {
    id: 'custom_rest',
    name: 'Custom REST (JSON)',
    offers: ['market_data'],
    assetClasses: ['stock', 'etf'],
    coverage: 'us',
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API key or token',
        help: 'From your provider’s dashboard. It is sealed when you send it and only ever sent to the feed’s own host.',
      },
    ],
  },
  cboe: {
    id: 'cboe',
    name: 'CBOE index history (daily)',
    offers: ['market_data'],
    assetClasses: ['index'],
    coverage: 'us',
    dataTypes: ['bars'],
    credentialFields: [],
  },
  sec: {
    id: 'sec',
    name: 'SEC EDGAR',
    offers: ['fundamentals'],
    assetClasses: ['stock'],
    coverage: 'us',
    credentialFields: [
      {
        name: 'contactEmail',
        label: 'Contact email',
        help: 'EDGAR is free and needs no key, but the SEC asks every app to name a contact. It is sent only to the SEC.',
      },
    ],
  },
} as const satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

/**
 * Whether a feed of this provider needs a stored credential. A custom REST
 * feed needs one only when its description signs in with a key (ADR 0041).
 */
export function providerNeedsKey(id: string, authType?: string | null): boolean {
  if (!isProviderId(id)) return false;
  if (id === 'custom_rest') return !!authType && authType !== 'none';
  return PROVIDERS[id].credentialFields.length > 0;
}

/** Providers whose connections need a stored credential. */
export const CREDENTIAL_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].credentialFields.length > 0,
);

/** Whether a provider gives company financials and profiles rather than prices (ADR 0031). */
export function isFundamentalsProvider(id: string): id is ProviderId {
  return isProviderId(id) && (PROVIDERS[id].offers as readonly string[]).includes('fundamentals');
}

/** Whether a provider gives prices, so its feeds can be routed. */
export function isMarketDataProvider(id: string): id is ProviderId {
  return isProviderId(id) && (PROVIDERS[id].offers as readonly string[]).includes('market_data');
}

/** The data a price feed is routed for as soon as it is added. */
export function providerDataTypes(id: string): readonly ('bars' | 'quotes')[] {
  if (!isProviderId(id)) return [];
  const info: ProviderInfo = PROVIDERS[id];
  return info.dataTypes ?? ['bars', 'quotes'];
}

export const FUNDAMENTALS_PROVIDER_IDS = PROVIDER_IDS.filter(isFundamentalsProvider);
export const MARKET_DATA_PROVIDER_IDS = PROVIDER_IDS.filter(isMarketDataProvider);

/** The venue code of the invented demo instruments. */
export const DEMO_VENUE_CODE = 'DEMO';

/** Whether a provider can serve instruments on this venue (null means any venue). */
export function providerCoversVenue(provider: string, venue: string | null): boolean {
  if (!isMarketDataProvider(provider)) return false;
  return PROVIDERS[provider].coverage === 'demo'
    ? venue === DEMO_VENUE_CODE
    : venue !== DEMO_VENUE_CODE;
}
