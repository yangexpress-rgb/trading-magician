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
  /** What a connection to this provider can be used for. */
  offers: readonly ('market_data' | 'broker')[];
  /** Empty for providers that need no sign-in, like the built-in demo. */
  credentialFields: readonly CredentialField[];
}

export const PROVIDERS = {
  demo: {
    id: 'demo',
    name: 'Demo (built in)',
    offers: ['market_data', 'broker'],
    credentialFields: [],
  },
  alpaca: {
    id: 'alpaca',
    name: 'Alpaca',
    offers: ['market_data', 'broker'],
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
} as const satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.hasOwn(PROVIDERS, value);
}

/** Providers whose connections need a stored credential. */
export const CREDENTIAL_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].credentialFields.length > 0,
);
