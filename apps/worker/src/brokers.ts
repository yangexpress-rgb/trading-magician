import type { AccountRouting, DiscoveredAccountInput, OpenedCredential } from '@tm/db';
import type { BrokerAdapter } from '@tm/domain';

/**
 * Broker platforms the worker can talk to (ADR 0018), keyed by provider id.
 * The demo platform is the built-in simulated broker and needs no entry.
 */
export interface BrokerContext {
  now: () => Date;
  credential?: OpenedCredential | undefined;
}

export interface BrokerProvider {
  needsCredential: boolean;
  /** Proves the connection and lists the accounts the key reaches. Throws on failure. */
  discover(ctx: BrokerContext): Promise<DiscoveredAccountInput[]>;
  adapter(
    ctx: BrokerContext,
    account: AccountRouting,
    instrumentIdFor: (symbol: string) => Promise<string | undefined>,
  ): BrokerAdapter;
}

export type BrokerRegistry = Partial<Record<string, BrokerProvider>>;
