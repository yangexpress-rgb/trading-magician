import {
  BrokerUnavailableError,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type BrokerOrderUpdate,
} from '@tm/domain';

/**
 * Wraps an adapter to inject the failures §17.4 asks the app to survive:
 * updates delivered twice and out of order, submissions that time out after
 * the broker took them, and disconnects while reading updates.
 */
export interface FaultOptions {
  seed: number;
  /** Chance each update is delivered a second time. */
  duplicateRate?: number;
  /** Shuffle each page of updates. */
  shuffle?: boolean;
  /** Chance a submission reaches the broker but the reply is lost. */
  lostReplyRate?: number;
  /** Chance a read of updates fails with a disconnect. */
  disconnectRate?: number;
}

function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function withFaults<T extends BrokerAdapter>(adapter: T, options: FaultOptions): T {
  const rand = random(options.seed);
  const chance = (p = 0) => rand() < p;
  const mess = (updates: BrokerOrderUpdate[]) => {
    const out = updates.flatMap((u) => (chance(options.duplicateRate) ? [u, u] : [u]));
    if (options.shuffle) {
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j] as BrokerOrderUpdate, out[i] as BrokerOrderUpdate];
      }
    }
    return out;
  };
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'submitOrder') {
        return async (request: BrokerOrderRequest) => {
          const result = await target.submitOrder(request);
          if (chance(options.lostReplyRate))
            throw new BrokerUnavailableError('Submission timed out');
          return result;
        };
      }
      if (prop === 'updates') {
        return async (accountId: string, cursor: string | undefined) => {
          if (chance(options.disconnectRate)) throw new BrokerUnavailableError('Disconnected');
          const page = await target.updates(accountId, cursor);
          return { ...page, updates: mess(page.updates) };
        };
      }
      if (prop === 'orderUpdates') {
        return async (accountId: string, id: string) =>
          mess(await target.orderUpdates(accountId, id));
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
