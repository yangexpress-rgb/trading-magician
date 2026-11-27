import { withFaults } from '@tm/broker';
import { describeBrokerContract, type ContractHarness } from '@tm/broker/testing';
import { BrokerRejectedError, deriveBrokerOrder, type BrokerOrderUpdate } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { alpacaCapabilities } from './account';
import {
  AlpacaBroker,
  appClientOrderId,
  insufficientQty,
  orderEvents,
  SPLIT_REST_RETRY_MS,
  timestampKey,
} from './broker';
import { AlpacaClient } from './client';
import order from './testing/fixtures/order.json';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from './testing';
import type { AlpacaOrder } from './types';

/** Tuesday 2026-10-06, 11:00 New York: mid-session, and 17:00 the same day. */
const OPEN = Date.parse('2026-10-06T15:00:00Z');
const CLOSED = Date.parse('2026-10-06T21:00:00Z');
const A = { instrumentId: '00000000-0000-4000-8000-0000000000a1', symbol: 'ZTSTA' };

const OPT = {
  instrumentId: '00000000-0000-4000-8000-0000000000c1',
  symbol: 'ZTSTA261120C00100000',
};
const OPT2 = {
  instrumentId: '00000000-0000-4000-8000-0000000000c2',
  symbol: 'ZTSTA261120C00105000',
};

function setup(
  clock: { t: number },
  options: { shortingEnabled?: boolean; optionsLevel?: number } = {},
) {
  const fake = new FakeAlpaca({ now: () => new Date(clock.t), ...options });
  if (options.optionsLevel !== undefined)
    fake.addOptionContracts([{ symbol: OPT.symbol }, { symbol: OPT2.symbol }]);
  const client = new AlpacaClient({
    credentials: fake.credentials,
    fetch: fake.fetch,
    tradingUrl: FAKE_ALPACA_TRADING_URL,
    dataUrl: FAKE_ALPACA_DATA_URL,
    allowLocal: true,
  });
  const broker = new AlpacaBroker({
    client,
    capabilities: {
      ...alpacaCapabilities({ shorting_enabled: options.shortingEnabled ?? true }),
      ...(options.optionsLevel !== undefined ? { options: true } : {}),
      ...(options.optionsLevel !== undefined && options.optionsLevel >= 3
        ? { optionCombos: true }
        : {}),
    },
    ...(options.optionsLevel !== undefined ? { optionsClient: client } : {}),
    instrumentIdFor: async (symbol) =>
      symbol === A.symbol
        ? A.instrumentId
        : symbol === OPT.symbol
          ? OPT.instrumentId
          : symbol === OPT2.symbol
            ? OPT2.instrumentId
            : undefined,
    now: () => new Date(clock.t),
  });
  return { fake, client, broker };
}

function alpacaHarness(faults?: Parameters<typeof withFaults>[1], optionsLevel?: number) {
  return async (): Promise<ContractHarness> => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock, optionsLevel !== undefined ? { optionsLevel } : {});
    let day = 0;
    return {
      ...(optionsLevel !== undefined
        ? {
            option: {
              ...OPT,
              underlying: A.symbol,
              setQuote: (bid: string, ask: string, fillAtMid?: boolean) =>
                fake.setOptionQuote(OPT.symbol, {
                  bid,
                  ask,
                  ...(fillAtMid ? { fillAtMid } : {}),
                }),
            },
          }
        : {}),
      ...(optionsLevel !== undefined && optionsLevel >= 3
        ? {
            comboOption: {
              ...OPT2,
              setQuote: (bid: string, ask: string) =>
                fake.setOptionQuote(OPT2.symbol, { bid, ask }),
              rejectNextCombo: () => fake.rejectNextCombo(),
            },
          }
        : {}),
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

describeBrokerContract('Alpaca paper (fake) with options level 2', alpacaHarness(undefined, 2));
describeBrokerContract('Alpaca paper (fake) with options level 3', alpacaHarness(undefined, 3));

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

/**
 * One Alpaca paper account shared by several strategies (N307, ADR 0105):
 * Alpaca nets every strategy's position in a symbol into one, and refuses an
 * order that would take that net position through zero. Each strategy must
 * still be able to close its own full position.
 */
describe('several strategies on one account (N307)', () => {
  const order = (clientOrderId: string, direction: 'buy' | 'sell', quantity: string) => ({
    clientOrderId,
    accountId: 'acct-1',
    ...A,
    direction,
    short: false,
    quantity,
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    extendedHours: false,
  });

  /** Every update so far, as the worker reads them, grouped by the app's client order id. */
  async function drain(broker: AlpacaBroker, state: { cursor?: string | undefined }) {
    const all: BrokerOrderUpdate[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await broker.updates('acct-1', state.cursor);
      all.push(...r.updates);
      if (r.cursor === state.cursor || r.updates.length === 0) break;
      state.cursor = r.cursor;
    }
    return all;
  }

  /** Steps the fake and reads updates until nothing new arrives. */
  async function settle(
    clock: { t: number },
    fake: FakeAlpaca,
    broker: AlpacaBroker,
    state: { cursor?: string | undefined; seen: BrokerOrderUpdate[] },
  ) {
    for (let i = 0; i < 5; i++) {
      clock.t += 5_000;
      await fake.tick();
      state.seen.push(...(await drain(broker, state)));
    }
  }

  /** The app's view of each intent: what the worker derives from the updates. */
  function intent(seen: BrokerOrderUpdate[], clientOrderId: string, quantity: string) {
    return deriveBrokerOrder(
      new Decimal(quantity),
      seen.filter((u) => u.clientOrderId === clientOrderId),
    );
  }

  /** A strategy's own position from its intents' fills. */
  function book(seen: BrokerOrderUpdate[], intents: Record<string, 1 | -1>) {
    let q = new Decimal(0);
    for (const [id, sign] of Object.entries(intents)) {
      for (const u of seen)
        if (u.clientOrderId === id && u.kind === 'fill' && u.fill)
          q = q.plus(new Decimal(u.fill.quantity).times(sign));
    }
    return q.toString();
  }

  const accountPosition = async (broker: AlpacaBroker) =>
    (await broker.positions('acct-1')).find((p) => p.instrumentId === A.instrumentId)?.quantity ??
    '0';

  it('reads Alpaca’s refusal of an order that would cross zero', () => {
    expect(
      insufficientQty('insufficient qty available for order (requested: 68, available: 34)'),
    ).toEqual({ requested: new Decimal(68), available: new Decimal(34) });
    expect(insufficientQty('account is not allowed to short')).toBeUndefined();
    expect(appClientOrderId('tm1-abc_1_34')).toBe('tm1-abc');
    expect(appClientOrderId('tm1-abc_2')).toBe('tm1-abc');
    expect(appClientOrderId('tm1-abc')).toBe('tm1-abc');
  });

  it('closes a strategy’s full long while another strategy is short the same symbol (Nov 19)', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    const state = { cursor: undefined as string | undefined, seen: [] as BrokerOrderUpdate[] };
    // S00033 buys 68; S00027 sells 34 short: the account is long 34.
    await broker.submitOrder(order('s33-entry', 'buy', '68'));
    await settle(clock, fake, broker, state);
    await broker.submitOrder({ ...order('s27-entry', 'sell', '34'), short: true });
    await settle(clock, fake, broker, state);
    expect(await accountPosition(broker)).toBe('34');

    // S00033 closes its own 68: Alpaca alone would refuse it (available: 34).
    await expect(broker.submitOrder(order('s33-close', 'sell', '68'))).resolves.toMatchObject({
      brokerOrderId: expect.any(String),
    });
    await settle(clock, fake, broker, state);

    expect(intent(state.seen, 's33-close', '68')).toMatchObject({ state: 'filled' });
    expect(intent(state.seen, 's33-close', '68').filledQuantity.toString()).toBe('68');
    expect(book(state.seen, { 's33-entry': 1, 's33-close': -1 })).toBe('0');
    expect(book(state.seen, { 's27-entry': -1 })).toBe('-34');
    // The account now holds exactly what the strategies hold together.
    expect(await accountPosition(broker)).toBe('-34');
    // Every update names an order the app placed: nothing for reconciliation to flag.
    const placed = new Set(['s33-entry', 's27-entry', 's33-close']);
    expect(state.seen.every((u) => placed.has(u.clientOrderId))).toBe(true);
  });

  it('closes a strategy’s full short while another strategy is long the same symbol', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    const state = { cursor: undefined as string | undefined, seen: [] as BrokerOrderUpdate[] };
    await broker.submitOrder({ ...order('a-entry', 'sell', '68'), short: true });
    await settle(clock, fake, broker, state);
    await broker.submitOrder(order('b-entry', 'buy', '34'));
    await settle(clock, fake, broker, state);
    expect(await accountPosition(broker)).toBe('-34');

    await broker.submitOrder(order('a-close', 'buy', '68'));
    await settle(clock, fake, broker, state);

    expect(intent(state.seen, 'a-close', '68')).toMatchObject({ state: 'filled' });
    expect(book(state.seen, { 'a-entry': -1, 'a-close': 1 })).toBe('0');
    expect(book(state.seen, { 'b-entry': 1 })).toBe('34');
    expect(await accountPosition(broker)).toBe('34');
  });

  it('sends one order when the account holds enough: two longs in the same symbol', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    const state = { cursor: undefined as string | undefined, seen: [] as BrokerOrderUpdate[] };
    await broker.submitOrder(order('a-entry', 'buy', '68'));
    await broker.submitOrder(order('b-entry', 'buy', '30'));
    await settle(clock, fake, broker, state);
    const posts = () => fake.requests.filter((r) => r.method === 'POST').length;
    const before = posts();
    await broker.submitOrder(order('a-close', 'sell', '68'));
    await settle(clock, fake, broker, state);
    expect(posts() - before).toBe(1);
    expect(intent(state.seen, 'a-close', '68')).toMatchObject({ state: 'filled' });
    expect(book(state.seen, { 'b-entry': 1 })).toBe('30');
    expect(await accountPosition(broker)).toBe('30');
  });

  it('gives reconciliation both parts of a split order under the app’s id', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    const state = { cursor: undefined as string | undefined, seen: [] as BrokerOrderUpdate[] };
    await broker.submitOrder(order('a-entry', 'buy', '68'));
    await settle(clock, fake, broker, state);
    await broker.submitOrder({ ...order('b-entry', 'sell', '34'), short: true });
    await settle(clock, fake, broker, state);
    const { brokerOrderId } = await broker.submitOrder(order('a-close', 'sell', '68'));
    await settle(clock, fake, broker, state);
    const updates = await broker.orderUpdates('acct-1', brokerOrderId);
    expect(new Set(updates.map((u) => u.clientOrderId))).toEqual(new Set(['a-close']));
    expect(deriveBrokerOrder(new Decimal(68), updates)).toMatchObject({ state: 'filled' });
  });

  it('ends the order with a stated reason when Alpaca keeps refusing the rest', async () => {
    const clock = { t: OPEN };
    const { fake, broker } = setup(clock);
    const state = { cursor: undefined as string | undefined, seen: [] as BrokerOrderUpdate[] };
    await broker.submitOrder(order('a-entry', 'buy', '68'));
    await settle(clock, fake, broker, state);
    // Another strategy's working sell holds 34 of the account's 68.
    await broker.submitOrder({
      ...order('b-exit', 'sell', '34'),
      orderType: 'limit',
      limitPrice: '100000',
    });
    await settle(clock, fake, broker, state);
    await broker.submitOrder(order('a-close', 'sell', '68'));
    await settle(clock, fake, broker, state);
    expect(intent(state.seen, 'a-close', '68')).toMatchObject({ state: 'partially_filled' });
    clock.t += SPLIT_REST_RETRY_MS;
    await settle(clock, fake, broker, state);
    const view = intent(state.seen, 'a-close', '68');
    expect(view.state).toBe('canceled');
    expect(view.filledQuantity.toString()).toBe('34');
    expect(view.reason).toMatch(/refused the other 34: insufficient qty available/);
  });
});
