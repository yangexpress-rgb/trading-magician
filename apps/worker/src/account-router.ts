import {
  instrumentIdForSymbol,
  openCredential,
  type AccountRouting,
  type OpenedCredential,
  type Transaction,
  type CredentialKey,
} from '@tm/db';
import {
  BrokerRejectedError,
  BrokerUnavailableError,
  NO_OPTIONS_REASON,
  liveTradingEnabled,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrderRequest,
} from '@tm/domain';
import type { BrokerRegistry } from './brokers';

/**
 * One broker adapter over several accounts (ADR 0018): each call goes to the
 * adapter of the account it names, built once per pass. The demo account
 * goes to the simulated paper broker; others to their platform's adapter.
 */
export function createAccountRouter(options: {
  paper: BrokerAdapter;
  resolve: (accountId: string) => Promise<BrokerAdapter>;
}): BrokerAdapter {
  const adapters = new Map<string, Promise<BrokerAdapter>>();
  const forAccount = (accountId: string) => {
    let adapter = adapters.get(accountId);
    if (!adapter) {
      adapter = options.resolve(accountId);
      adapters.set(accountId, adapter);
      // A failure to open the account is retried on the next pass, not cached.
      adapter.catch(() => adapters.delete(accountId));
    }
    return adapter;
  };
  const capabilities: BrokerCapabilities = options.paper.capabilities;
  return {
    id: 'account-router',
    capabilities,
    async submitOrder(request: BrokerOrderRequest) {
      return (await forAccount(request.accountId)).submitOrder(request);
    },
    async cancelOrder(accountId, brokerOrderId) {
      return (await forAccount(accountId)).cancelOrder(accountId, brokerOrderId);
    },
    async updates(accountId, cursor) {
      return (await forAccount(accountId)).updates(accountId, cursor);
    },
    async orderUpdates(accountId, brokerOrderId) {
      return (await forAccount(accountId)).orderUpdates(accountId, brokerOrderId);
    },
    async positions(accountId) {
      return (await forAccount(accountId)).positions(accountId);
    },
    async account(accountId) {
      const adapter = await forAccount(accountId);
      return adapter.account ? adapter.account(accountId) : undefined;
    },
    // Options (ADR 0123): only an adapter that trades options answers.
    async optionQuotes(accountId, symbols) {
      const adapter = await forAccount(accountId);
      if (!adapter.capabilities.options || !adapter.optionQuotes)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.optionQuotes(accountId, symbols);
    },
    async replaceOrder(accountId, brokerOrderId, change) {
      const adapter = await forAccount(accountId);
      if (!adapter.capabilities.options || !adapter.replaceOrder)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.replaceOrder(accountId, brokerOrderId, change);
    },
    async submitMultiLeg(request) {
      const adapter = await forAccount(request.accountId);
      if (!adapter.capabilities.optionCombos || !adapter.submitMultiLeg)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.submitMultiLeg(request);
    },
    async optionDeltas(accountId, symbols) {
      const adapter = await forAccount(accountId);
      if (!adapter.capabilities.options || !adapter.optionDeltas)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.optionDeltas(accountId, symbols);
    },
    async optionActivities(accountId, after) {
      const adapter = await forAccount(accountId);
      if (!adapter.capabilities.options || !adapter.optionActivities)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.optionActivities(accountId, after);
    },
    async cashDividends(accountId, symbol, from, to) {
      const adapter = await forAccount(accountId);
      if (!adapter.capabilities.options || !adapter.cashDividends)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.cashDividends(accountId, symbol, from, to);
    },
    async optionContracts(accountId, query) {
      const adapter = await forAccount(accountId);
      if (!adapter.capabilities.options || !adapter.optionContracts)
        throw new BrokerRejectedError('options_unsupported', NO_OPTIONS_REASON);
      return adapter.optionContracts(accountId, query);
    },
  };
}

/**
 * Opens each account's adapter: the demo account's is the simulated paper
 * broker; others come from their platform's provider, signed in with the
 * platform's stored key. An account that cannot be opened reads as an
 * unreachable broker, so the broker-down pause applies (ADR 0018).
 */
export function accountResolver(options: {
  tx: Transaction;
  userId: string;
  accounts: ReadonlyMap<string, AccountRouting>;
  paper: BrokerAdapter;
  brokers: BrokerRegistry | undefined;
  privateKey: CredentialKey | undefined;
  now: () => Date;
}): (accountId: string) => Promise<BrokerAdapter> {
  const { tx, userId, accounts, paper } = options;
  return async (accountId) => {
    const account = accounts.get(accountId);
    if (!account || account.provider === 'demo') return paper;
    const provider = options.brokers?.[account.provider];
    if (!provider) throw new AccountUnavailableError(`${account.nickname} has no adapter here`);
    if (!account.platformActive) {
      throw new AccountUnavailableError(`${account.nickname}'s platform is turned off`);
    }
    // The order's run → account → environment decides the endpoint (ADR 0109). A live
    // account is reached only while the server's live-trading flag is on.
    if (account.environment === 'live' && !liveTradingEnabled()) {
      throw new AccountUnavailableError(
        `${account.nickname} is a live account and live trading is turned off on this server`,
      );
    }
    let credential: OpenedCredential | undefined;
    if (provider.needsCredential) {
      if (!account.credentialRef) {
        throw new AccountUnavailableError(`${account.nickname} has no API key`);
      }
      try {
        credential = await openCredential(tx, {
          userId,
          id: account.credentialRef,
          privateKey: options.privateKey,
        });
      } catch {
        throw new AccountUnavailableError(`${account.nickname}'s API key could not be opened`);
      }
    }
    if (credential && credential.environment !== account.environment) {
      throw new AccountUnavailableError(
        `${account.nickname}'s API key is for ${credential.environment}, not ${account.environment}`,
      );
    }
    return provider.adapter(
      { now: options.now, credential, environment: account.environment },
      account,
      (symbol) => instrumentIdForSymbol(tx, symbol),
    );
  };
}

export class AccountUnavailableError extends BrokerUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'AccountUnavailableError';
  }
}
