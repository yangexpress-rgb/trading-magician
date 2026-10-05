import { withFaults } from '@tm/broker';
import { describeBrokerContract, type ContractHarness } from '@tm/broker/testing';
import { BrokerRejectedError } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { alpacaCapabilities } from './account';
import { AlpacaBroker, orderEvents, timestampKey } from './broker';
import { AlpacaClient } from './client';
import order from './testing/fixtures/order.json';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from './testing';
import type { AlpacaOrder } from './types';

/** Tuesday 2026-10-06, 11:00 New York: mid-session, and 17:00 the same day. */
const OPEN = Date.parse('2026-10-06T15:00:00Z');
const CLOSED = Date.parse('2026-10-06T21:00:00Z');
const A = { instrumentId: '00000000-0000-4000-8000-0000000000a1', symbol: 'ZTSTA' };

function setup(clock: { t: number }, options: { shortingEnabled?: boolean } = {}) {
  const fake = new FakeAlpaca({ now: () => new Date(clock.t), ...options });
  const client = new AlpacaClient({
    credentials: fake.credentials,
    fetch: fake.fetch,
    tradingUrl: FAKE_ALPACA_TRADING_URL,
    dataUrl: FAKE_ALPACA_DATA_URL,
    allowLocal: true,
  });
  const broker = new AlpacaBroker({
    client,
    capabilities: alpacaCapabilities({ shorting_enabled: options.shortingEnabled ?? true }),
    instrumentIdFor: async (symbol) => (symbol === A.symbol ? A.instrumentId : undefined),
  });
  return { fake, client, broker };
}

function alpacaHarness(faults?: Parameters<typeof withFaults>[1]) {
  return async (): Promise<ContractHarness> => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    let day = 0;
    return {
      adapter: faults ? withFaults(broker, faults) : broker,
      accountId: 'acct-1',
      instrument: A,
      largeQuantity: '5000',
      async openMarket() {
        clock.t = OPEN + day * 86_400_000;
      },
      async closeMarket() {
        clock.t = CLOSED + day * 86_400_000;
        day += 1;
        await fake.tick();
      },
      async advance(ms) {
        const end = clock.t + ms;
        do {
          clock.t = Math.min(end, clock.t + 1_000);
          await fake.tick();
        } while (clock.t < end);
      },
      async lastPrice() {
        const res = await fake.fetch(`https://data.alpaca.markets/v2/stocks/ZTSTA/snapshot`, {
          headers: {
            'APCA-API-KEY-ID': fake.credentials.keyId,
            'APCA-API-SECRET-KEY': fake.credentials.secretKey,
          },
        });
        const { Decimal } = await import('decimal.js');
        return new Decimal(((await res.json()) as { latestTrade: { p: number } }).latestTrade.p);
      },
    };
  };
}

describeBrokerContract('Alpaca paper (fake)', alpacaHarness());
describeBrokerContract(
  'Alpaca paper (fake) with duplicated, reordered updates, lost replies and disconnects',
  alpacaHarness({
    seed: 11,
    duplicateRate: 0.3,
    shuffle: true,
    lostReplyRate: 0.3,
    disconnectRate: 0.2,
  }),
);

describe('Alpaca broker adapter', () => {
  it('reads an order’s state into normalized events', () => {
    const filled = order as AlpacaOrder;
    expect(orderEvents(filled).map((e) => e.kind)).toEqual(['accepted']);
    expect(orderEvents({ ...filled, status: 'canceled', canceled_at: filled.updated_at })).toEqual([
      expect.objectContaining({ kind: 'accepted' }),
      expect.objectContaining({ kind: 'canceled', eventId: `${filled.id}:canceled` }),
    ]);
    expect(orderEvents({ ...filled, status: 'rejected' })).toEqual([
      expect.objectContaining({ kind: 'rejected' }),
    ]);
    expect(orderEvents({ ...filled, status: 'pending_new' })).toEqual([]);
  });

  it('orders timestamps of any precision', () => {
    expect(
      timestampKey('2026-10-06T15:00:00.1Z') < timestampKey('2026-10-06T15:00:00.123456Z'),
    ).toBe(true);
    expect(timestampKey('2026-10-06T15:00:00Z')).toBe('2026-10-06T15:00:00.000000000Z');
  });

  it('refuses orders Alpaca would not take, before sending them', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock, { shortingEnabled: false });
    const base = {
      clientOrderId: 'c-1',
      accountId: 'acct-1',
      ...A,
      direction: 'buy' as const,
      short: false,
      quantity: '1',
      orderType: 'market' as const,
      timeInForce: 'day' as const,
      extendedHours: false,
    };
    await expect(broker.submitOrder({ ...base, extendedHours: true })).rejects.toMatchObject({
      code: 'extended_hours',
    });
    await expect(
      broker.submitOrder({ ...base, direction: 'sell', short: true }),
    ).rejects.toBeInstanceOf(BrokerRejectedError);
    await expect(broker.submitOrder({ ...base, quantity: '1.5' })).rejects.toMatchObject({
      code: 'fractional',
    });
    expect(fake.requests.filter((r) => r.method === 'POST')).toEqual([]);
    // A day limit order may trade extended hours.
    await broker.submitOrder({
      ...base,
      clientOrderId: 'c-2',
      orderType: 'limit',
      limitPrice: '1.00',
      extendedHours: true,
    });
  });

  it('reports positions under the app’s instrument ids, short as negative', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    await broker.submitOrder({
      clientOrderId: 'short-1',
      accountId: 'acct-1',
      ...A,
      direction: 'sell',
      short: true,
      quantity: '3',
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
    });
    clock.t += 5_000;
    await fake.tick();
    expect(await broker.positions('acct-1')).toEqual([
      expect.objectContaining({ instrumentId: A.instrumentId, quantity: '-3' }),
    ]);
  });

  it('treats Alpaca being down as retryable', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    fake.failNext(503);
    await expect(broker.positions('acct-1')).rejects.toMatchObject({
      name: 'AlpacaUnavailableError',
    });
    expect(await broker.positions('acct-1')).toEqual([]);
  });
});
