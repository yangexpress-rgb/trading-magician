import {
  BrokerUnavailableError,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrderRequest,
} from '@tm/domain';

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
  };
}

export class AccountUnavailableError extends BrokerUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = 'AccountUnavailableError';
  }
}
