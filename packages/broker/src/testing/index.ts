import {
  BrokerRejectedError,
  BrokerUnavailableError,
  deriveBrokerOrder,
  isTerminalOrderState,
  type BrokerAdapter,
  type BrokerOrderRequest,
  type BrokerOrderUpdate,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';

/**
 * The broker adapter contract suite (Design v1.0 §17.4). Every adapter runs
 * it: the simulated paper broker against the demo feed, and real brokers'
 * sandboxes as they are added. A harness supplies the adapter and a way to
 * move time on.
 */
export interface ContractHarness {
  adapter: BrokerAdapter;
  accountId: string;
  instrument: { instrumentId: string; symbol: string };
  /** A quantity too large to fill against a single quote. */
  largeQuantity: string;
  /** Puts the market in the middle of a regular session. */
  openMarket(): Promise<void>;
  /** Puts the market after the close, before the next session. */
  closeMarket(): Promise<void>;
  /** Moves time forward, letting the broker work its orders. */
  advance(ms: number): Promise<void>;
  /** Current last price of the instrument. */
  lastPrice(): Promise<Decimal>;
}

let seq = 0;

/** Reads every update from the start, retrying through disconnects. */
export async function drainUpdates(
  adapter: BrokerAdapter,
  accountId: string,
): Promise<BrokerOrderUpdate[]> {
  const all: BrokerOrderUpdate[] = [];
  let cursor: string | undefined;
  for (let attempts = 0; attempts < 500; attempts++) {
    let page;
    try {
      page = await adapter.updates(accountId, cursor);
    } catch (e) {
      if (e instanceof BrokerUnavailableError) continue;
      throw e;
    }
    all.push(...page.updates);
    if (page.updates.length === 0 && page.cursor === cursor) return all;
    cursor = page.cursor;
  }
  throw new Error('updates never settled');
}

/** Submits, retrying lost replies with the same client order id. */
export async function submitWithRetry(adapter: BrokerAdapter, request: BrokerOrderRequest) {
  for (let attempts = 0; attempts < 20; attempts++) {
    try {
      return await adapter.submitOrder(request);
    } catch (e) {
      if (!(e instanceof BrokerUnavailableError)) throw e;
    }
  }
  throw new Error('submit never succeeded');
}

export function describeBrokerContract(name: string, setup: () => Promise<ContractHarness>) {
  const request = (
    h: ContractHarness,
    o: Partial<BrokerOrderRequest> = {},
  ): BrokerOrderRequest => ({
    clientOrderId: `contract-${++seq}`,
    accountId: h.accountId,
    instrumentId: h.instrument.instrumentId,
    symbol: h.instrument.symbol,
    direction: 'buy',
    short: false,
    quantity: '10',
    orderType: 'market',
    timeInForce: 'day',
    extendedHours: false,
    ...o,
  });
  const view = async (h: ContractHarness, brokerOrderId: string, quantity: string) => {
    const updates = (await drainUpdates(h.adapter, h.accountId)).filter(
      (u) => u.brokerOrderId === brokerOrderId,
    );
    return deriveBrokerOrder(new Decimal(quantity), updates);
  };

  describe(`broker contract: ${name}`, () => {
    it('never claims atomic multi-leg fills unless it provides them', async () => {
      const h = await setup();
      expect(typeof h.adapter.capabilities.atomicMultiLeg).toBe('boolean');
      expect(h.adapter.capabilities.orderTypes).toContain('market');
    });

    it('accepts and fills a market order during the session', async () => {
      const h = await setup();
      await h.openMarket();
      const { brokerOrderId } = await submitWithRetry(h.adapter, request(h));
      await h.advance(10_000);
      const v = await view(h, brokerOrderId, '10');
      expect(v.state).toBe('filled');
      expect(v.filledQuantity.toString()).toBe('10');
      expect(v.averagePrice?.gt(0)).toBe(true);
      const held = await h.adapter.positions(h.accountId);
      expect(held.find((p) => p.instrumentId === h.instrument.instrumentId)?.quantity).toBe('10');
    });

    it('returns the original order when the same client order id is sent again', async () => {
      const h = await setup();
      await h.openMarket();
      const r = request(h);
      const first = await submitWithRetry(h.adapter, r);
      const second = await submitWithRetry(h.adapter, { ...r, quantity: '999' });
      expect(second.brokerOrderId).toBe(first.brokerOrderId);
      await h.advance(10_000);
      expect((await view(h, first.brokerOrderId, '10')).filledQuantity.toString()).toBe('10');
    });

    it('keeps a limit away from the market working until it is canceled', async () => {
      const h = await setup();
      await h.openMarket();
      const far = (await h.lastPrice()).times('0.5').toDecimalPlaces(2).toString();
      const { brokerOrderId } = await submitWithRetry(
        h.adapter,
        request(h, { orderType: 'limit', limitPrice: far, timeInForce: 'gtc' }),
      );
      await h.advance(30_000);
      expect((await view(h, brokerOrderId, '10')).state).toBe('acknowledged');
      await h.adapter.cancelOrder(h.accountId, brokerOrderId);
      await h.adapter.cancelOrder(h.accountId, brokerOrderId);
      const v = await view(h, brokerOrderId, '10');
      expect(v.state).toBe('canceled');
      const updates = await h.adapter.orderUpdates(h.accountId, brokerOrderId);
      const cancels = updates.filter((u) => u.kind === 'canceled');
      expect(new Set(cancels.map((u) => u.eventId)).size).toBe(1);
    });

    it('holds orders placed while the market is closed until the next session', async () => {
      const h = await setup();
      await h.closeMarket();
      const { brokerOrderId } = await submitWithRetry(h.adapter, request(h));
      await h.advance(60_000);
      expect((await view(h, brokerOrderId, '10')).state).toBe('acknowledged');
      await h.openMarket();
      await h.advance(10_000);
      expect((await view(h, brokerOrderId, '10')).state).toBe('filled');
    });

    it('expires a day order at the close', async () => {
      const h = await setup();
      await h.openMarket();
      const far = (await h.lastPrice()).times('0.5').toDecimalPlaces(2).toString();
      const { brokerOrderId } = await submitWithRetry(
        h.adapter,
        request(h, { orderType: 'limit', limitPrice: far }),
      );
      await h.closeMarket();
      await h.advance(1_000);
      expect((await view(h, brokerOrderId, '10')).state).toBe('expired');
    });

    it('fills a large order partially across several quotes', async () => {
      const h = await setup();
      await h.openMarket();
      const q = h.largeQuantity;
      const { brokerOrderId } = await submitWithRetry(h.adapter, request(h, { quantity: q }));
      await h.advance(1_000);
      const partial = await view(h, brokerOrderId, q);
      expect(partial.state).toBe('partially_filled');
      await h.advance(120_000);
      const done = await view(h, brokerOrderId, q);
      expect(done.state).toBe('filled');
      const fills = (await h.adapter.orderUpdates(h.accountId, brokerOrderId)).filter(
        (u) => u.kind === 'fill',
      );
      expect(fills.length).toBeGreaterThan(1);
    });

    it('cancels what an immediate-or-cancel order could not fill, and all of an unfillable fill-or-kill', async () => {
      const h = await setup();
      await h.openMarket();
      const q = h.largeQuantity;
      const ioc = await submitWithRetry(h.adapter, request(h, { quantity: q, timeInForce: 'ioc' }));
      const fok = await submitWithRetry(h.adapter, request(h, { quantity: q, timeInForce: 'fok' }));
      await h.advance(5_000);
      const i = await view(h, ioc.brokerOrderId, q);
      expect(i.state).toBe('canceled');
      expect(i.filledQuantity.gt(0)).toBe(true);
      const f = await view(h, fok.brokerOrderId, q);
      expect(f.state).toBe('canceled');
      expect(f.filledQuantity.isZero()).toBe(true);
    });

    it('rejects requests outside its capabilities before accepting them', async () => {
      const h = await setup();
      await h.openMarket();
      if (!h.adapter.capabilities.extendedHours) {
        await expect(
          h.adapter.submitOrder(request(h, { extendedHours: true })),
        ).rejects.toBeInstanceOf(BrokerRejectedError);
      }
      await expect(
        h.adapter.submitOrder(request(h, { orderType: 'limit', limitPrice: undefined })),
      ).rejects.toBeInstanceOf(BrokerRejectedError);
    });

    it('never repeats an update to a reader that keeps its cursor', async () => {
      const h = await setup();
      await h.openMarket();
      await submitWithRetry(h.adapter, request(h));
      let cursor: string | undefined;
      const seen: string[] = [];
      for (let i = 0; i < 5; i++) {
        await h.advance(2_000);
        try {
          const page = await h.adapter.updates(h.accountId, cursor);
          seen.push(...page.updates.map((u) => u.eventId));
          cursor = page.cursor;
        } catch (e) {
          if (!(e instanceof BrokerUnavailableError)) throw e;
        }
      }
      // Fault injection may duplicate within a page; a cursor never replays an earlier page.
      const all = await drainUpdates(h.adapter, h.accountId);
      expect(new Set(seen)).toEqual(new Set(all.map((u) => u.eventId)));
    });

    it('settles every order in a terminal state the app can derive', async () => {
      const h = await setup();
      await h.openMarket();
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const r = request(h, { direction: i % 2 ? 'sell' : 'buy', short: i % 2 === 1 });
        ids.push(await submitWithRetry(h.adapter, r));
      }
      await h.advance(20_000);
      for (const { brokerOrderId } of ids) {
        expect(isTerminalOrderState((await view(h, brokerOrderId, '10')).state)).toBe(true);
      }
    });
  });
}
