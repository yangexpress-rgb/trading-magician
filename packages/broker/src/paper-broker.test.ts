import { createDemoLiveFeed } from '@tm/market-data';
import { deriveBrokerOrder } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { withFaults } from './faults';
import { PaperBroker } from './paper-broker';
import { MemoryPaperBrokerStore } from './store';
import {
  describeBrokerContract,
  drainUpdates,
  submitWithRetry,
  type ContractHarness,
} from './testing';

/** Tuesday 2026-10-06, 11:00 New York: mid-session. */
const OPEN = Date.parse('2026-10-06T15:00:00Z');
/** The same day, 17:00 New York: after the close. */
const CLOSED = Date.parse('2026-10-06T21:00:00Z');
const A = { instrumentId: '00000000-0000-4000-8000-00000000000a', symbol: 'DEMO-A' };

function paperHarness(faults?: Parameters<typeof withFaults>[1]) {
  return async (): Promise<ContractHarness> => {
    let t = OPEN;
    const now = () => new Date(t);
    const quotes = createDemoLiveFeed({ now });
    let n = 0;
    const broker = new PaperBroker({
      quotes,
      store: new MemoryPaperBrokerStore(),
      now,
      newId: () => `paper-${++n}`,
    });
    const adapter = faults ? withFaults(broker, faults) : broker;
    let day = 0;
    return {
      adapter,
      accountId: 'acct-1',
      instrument: A,
      largeQuantity: '5000',
      async openMarket() {
        // After a close, this is the next day's session, so time only moves forward.
        t = OPEN + day * 86_400_000;
      },
      async closeMarket() {
        t = CLOSED + day * 86_400_000;
        day += 1;
      },
      async advance(ms) {
        const end = t + ms;
        do {
          t = Math.min(end, t + 1_000);
          await broker.tick();
        } while (t < end);
      },
      async lastPrice() {
        return (await quotes.latestQuote(A))!.last;
      },
    };
  };
}

describeBrokerContract('paper broker', paperHarness());
describeBrokerContract(
  'paper broker with duplicated, reordered updates, lost replies and disconnects',
  paperHarness({
    seed: 7,
    duplicateRate: 0.3,
    shuffle: true,
    lostReplyRate: 0.3,
    disconnectRate: 0.2,
  }),
);

describe('paper broker fills', () => {
  const setup = async () => {
    let t = OPEN;
    const now = () => new Date(t);
    const quotes = createDemoLiveFeed({ now });
    const broker = new PaperBroker({ quotes, store: new MemoryPaperBrokerStore(), now });
    return { broker, quotes, step: (ms: number) => (t += ms) };
  };

  it('buys market orders at the ask plus 5 bps of slippage', async () => {
    const { broker, quotes } = await setup();
    const q = (await quotes.latestQuote(A))!;
    const { brokerOrderId } = await broker.submitOrder({
      clientOrderId: 'm1',
      accountId: 'x',
      ...A,
      direction: 'buy',
      short: false,
      quantity: '10',
      orderType: 'market',
      timeInForce: 'day',
      extendedHours: false,
    });
    await broker.tick();
    const v = deriveBrokerOrder(new Decimal(10), await broker.orderUpdates('x', brokerOrderId));
    expect(v.averagePrice?.toString()).toBe(q.ask.times('1.0005').toDecimalPlaces(4).toString());
  });

  it('fills a buy limit at the ask once the ask reaches it, never above the limit', async () => {
    const { broker, quotes, step } = await setup();
    const q = (await quotes.latestQuote(A))!;
    const { brokerOrderId } = await broker.submitOrder({
      clientOrderId: 'l1',
      accountId: 'x',
      ...A,
      direction: 'buy',
      short: false,
      quantity: '10',
      orderType: 'limit',
      limitPrice: q.ask.toString(),
      timeInForce: 'gtc',
      extendedHours: false,
    });
    await broker.tick();
    step(60_000);
    const v = deriveBrokerOrder(new Decimal(10), await broker.orderUpdates('x', brokerOrderId));
    expect(v.state).toBe('filled');
    expect(v.averagePrice!.lte(q.ask)).toBe(true);
  });

  it('tracks short positions and their average cost', async () => {
    const { broker } = await setup();
    for (const [id, direction] of [
      ['s1', 'sell'],
      ['s2', 'sell'],
      ['b1', 'buy'],
    ] as const) {
      await broker.submitOrder({
        clientOrderId: id,
        accountId: 'x',
        ...A,
        direction,
        short: direction === 'sell',
        quantity: '10',
        orderType: 'market',
        timeInForce: 'day',
        extendedHours: false,
      });
      await broker.tick();
    }
    const [p] = await broker.positions('x');
    expect(p?.quantity).toBe('-10');
    expect(Number(p?.averageCost)).toBeGreaterThan(0);
  });

  it('converges on the same order states however updates arrive', async () => {
    const plain = paperHarness();
    const faulty = paperHarness({ seed: 11, duplicateRate: 0.5, shuffle: true });
    const states = [];
    for (const make of [plain, faulty]) {
      const h = await make();
      await h.openMarket();
      const ids = [];
      for (let i = 0; i < 4; i++) {
        ids.push(
          (
            await submitWithRetry(h.adapter, {
              clientOrderId: `c${i}`,
              accountId: h.accountId,
              ...A,
              direction: 'buy',
              short: false,
              quantity: i === 0 ? '5000' : '10',
              orderType: 'market',
              timeInForce: i === 1 ? 'ioc' : 'day',
              extendedHours: false,
            })
          ).brokerOrderId,
        );
      }
      await h.advance(3_000);
      const updates = await drainUpdates(h.adapter, h.accountId);
      states.push(
        ids.map((id, i) => {
          const v = deriveBrokerOrder(
            new Decimal(i === 0 ? 5000 : 10),
            updates.filter((u) => u.brokerOrderId === id),
          );
          return [v.state, v.filledQuantity.toString(), v.averagePrice?.toString()];
        }),
      );
    }
    expect(states[1]).toEqual(states[0]);
  });
});
