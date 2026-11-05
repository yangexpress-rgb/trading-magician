import {
  BrokerRejectedError,
  nextTradingDay,
  nyDate,
  regularSession,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrderRequest,
  type BrokerOrderUpdate,
  type BrokerPosition,
  type BrokerUpdate,
  type LiveQuoteProvider,
  type Quote,
} from '@tm/domain';
import Decimal from 'decimal.js';
import type { PaperBrokerStore, PaperOrder } from './store';

/**
 * The built-in simulated paper broker (§18 Phase 3, §20 #2 default awaiting
 * confirmation). It fills against the live quote feed with the same cost
 * defaults as the back test: market orders take the ask or bid plus slippage,
 * limits fill when the quote reaches them, stops trigger on the last price,
 * and no fill takes more than the size available at one quote, so large orders
 * fill partially over several quotes. Day orders expire at the session close.
 * Nothing here can reach a real market.
 */

export const PAPER_BROKER_ID = 'paper-sim';
export const PAPER_CAPABILITIES: BrokerCapabilities = {
  orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
  timeInForce: ['day', 'gtc', 'ioc', 'fok'],
  extendedHours: false,
  fractionalQuantities: false,
  shortSelling: true,
  atomicMultiLeg: false,
};

export interface PaperBrokerOptions {
  quotes: LiveQuoteProvider;
  store: PaperBrokerStore;
  now?: () => Date;
  /** Slippage on market and triggered stop orders, in basis points (back-test default 5). */
  slippageBps?: Decimal.Value;
  commissionPerShare?: Decimal.Value;
  minCommission?: Decimal.Value;
  /** Creates broker order ids; tests pass a counter. */
  newId?: () => string;
}

const ZERO = new Decimal(0);
const UPDATES_PAGE = 500;

export class PaperBroker implements BrokerAdapter {
  readonly id = PAPER_BROKER_ID;
  readonly capabilities = PAPER_CAPABILITIES;
  private readonly now: () => Date;
  private readonly slippage: Decimal;
  private readonly perShare: Decimal;
  private readonly minCommission: Decimal;
  private readonly newId: () => string;

  constructor(private readonly options: PaperBrokerOptions) {
    this.now = options.now ?? (() => new Date());
    this.slippage = new Decimal(options.slippageBps ?? 5).div(10_000);
    this.perShare = new Decimal(options.commissionPerShare ?? 0);
    this.minCommission = new Decimal(options.minCommission ?? 0);
    this.newId = options.newId ?? (() => `paper-${crypto.randomUUID()}`);
  }

  async submitOrder(request: BrokerOrderRequest): Promise<{ brokerOrderId: string }> {
    const { store } = this.options;
    const existing = await store.findByClientOrderId(request.accountId, request.clientOrderId);
    if (existing) return { brokerOrderId: existing.brokerOrderId };
    validate(request);

    const now = this.now();
    const order: PaperOrder = {
      brokerOrderId: this.newId(),
      request,
      status: 'working',
      filled: '0',
      triggered: false,
      expiresAt: request.timeInForce === 'day' ? sessionCloseFor(now) : undefined,
      acceptedAt: now.toISOString(),
      updateCount: 0,
    };
    await store.insert(order);
    await this.emit(order, { kind: 'accepted', rawStatus: 'accepted' });
    await store.save(order);
    return { brokerOrderId: order.brokerOrderId };
  }

  async cancelOrder(accountId: string, brokerOrderId: string): Promise<void> {
    const { store } = this.options;
    const order = await store.get(accountId, brokerOrderId);
    if (!order) throw new BrokerRejectedError('not_found', 'The broker has no such order');
    if (order.status !== 'working') return;
    order.status = 'canceled';
    await this.emit(order, {
      kind: 'canceled',
      rawStatus: 'canceled',
      reason: 'Canceled on request',
    });
    await store.save(order);
  }

  async updates(accountId: string, cursor: string | undefined) {
    const from = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(from) || from < 0) {
      throw new BrokerRejectedError('bad_cursor', 'The update cursor is not valid');
    }
    const page = await this.options.store.updatesAfter(accountId, from, UPDATES_PAGE);
    return { updates: page.updates, cursor: String(page.cursor) };
  }

  async orderUpdates(accountId: string, brokerOrderId: string): Promise<BrokerOrderUpdate[]> {
    return this.options.store.orderUpdates(accountId, brokerOrderId);
  }

  async positions(accountId: string): Promise<BrokerPosition[]> {
    return this.options.store.positions(accountId);
  }

  /**
   * Matches every working order against the current quotes. The worker calls
   * this on each pass; a real broker does the equivalent on its own.
   */
  async tick(): Promise<void> {
    const now = this.now();
    for (const order of await this.options.store.working()) {
      await this.process(order, now);
    }
  }

  private async process(order: PaperOrder, now: Date) {
    const { store, quotes } = this.options;
    const r = order.request;
    if (order.expiresAt && now.getTime() >= Date.parse(order.expiresAt)) {
      order.status = 'expired';
      await this.emit(order, {
        kind: 'expired',
        rawStatus: 'expired',
        reason: 'Day order expired',
      });
      await store.save(order);
      return;
    }
    const quote = await quotes.latestQuote({ instrumentId: r.instrumentId, symbol: r.symbol });
    if (!quote?.marketOpen) return;

    const remaining = new Decimal(r.quantity).minus(order.filled);
    const price = this.executablePrice(order, quote);
    const immediate = r.timeInForce === 'ioc' || r.timeInForce === 'fok';
    if (price) {
      const take = Decimal.min(remaining, quote.size);
      if (r.timeInForce === 'fok' && take.lt(remaining)) {
        order.status = 'canceled';
        await this.emit(order, {
          kind: 'canceled',
          rawStatus: 'fok_unfilled',
          reason: 'Not enough size to fill the whole order at once',
        });
      } else {
        await this.fill(order, take, price, now);
      }
    }
    if (immediate && order.status === 'working') {
      order.status = 'canceled';
      await this.emit(order, {
        kind: 'canceled',
        rawStatus: 'ioc_remainder_canceled',
        reason: 'Unfilled quantity canceled (immediate or cancel)',
      });
    }
    await store.save(order);
  }

  /** The price this order can trade at now, or undefined if it can't. */
  private executablePrice(order: PaperOrder, quote: Quote): Decimal | undefined {
    const r = order.request;
    const buy = r.direction === 'buy';
    if ((r.orderType === 'stop' || r.orderType === 'stop_limit') && !order.triggered) {
      const stop = new Decimal(r.stopPrice ?? 0);
      if (buy ? quote.last.lt(stop) : quote.last.gt(stop)) return undefined;
      order.triggered = true;
    }
    const touch = buy ? quote.ask : quote.bid;
    if (r.orderType === 'market' || r.orderType === 'stop') {
      const slip = touch.times(this.slippage);
      return (buy ? touch.plus(slip) : touch.minus(slip)).toDecimalPlaces(4);
    }
    const limit = new Decimal(r.limitPrice ?? 0);
    if (buy ? touch.gt(limit) : touch.lt(limit)) return undefined;
    return touch;
  }

  private async fill(order: PaperOrder, quantity: Decimal, price: Decimal, now: Date) {
    const r = order.request;
    const fee =
      this.perShare.isZero() && this.minCommission.isZero()
        ? ZERO
        : Decimal.max(quantity.times(this.perShare), this.minCommission);
    order.filled = new Decimal(order.filled).plus(quantity).toString();
    const done = new Decimal(order.filled).gte(r.quantity);
    if (done) order.status = 'filled';
    await this.emit(
      order,
      {
        kind: 'fill',
        rawStatus: done ? 'filled' : 'partially_filled',
        fill: { quantity: quantity.toString(), price: price.toString(), fee: fee.toString() },
      },
      now,
    );

    const { store } = this.options;
    const signed = r.direction === 'buy' ? quantity : quantity.negated();
    const held = await store.position(r.accountId, r.instrumentId);
    const before = new Decimal(held?.quantity ?? 0);
    const after = before.plus(signed);
    let cost = held?.averageCost ? new Decimal(held.averageCost) : undefined;
    if (after.isZero()) cost = undefined;
    else if (before.isZero() || before.isNegative() !== after.isNegative()) cost = price;
    else if (after.abs().gt(before.abs()) && cost) {
      cost = cost.times(before.abs()).plus(price.times(quantity)).div(after.abs());
    }
    await store.setPosition(r.accountId, {
      instrumentId: r.instrumentId,
      quantity: after.toString(),
      averageCost: cost?.toDecimalPlaces(6).toString(),
    });
  }

  private async emit(
    order: PaperOrder,
    u: Omit<BrokerUpdate, 'eventId' | 'at'>,
    at: Date = this.now(),
  ) {
    order.updateCount += 1;
    const update: BrokerOrderUpdate = {
      ...u,
      eventId: `${order.brokerOrderId}:${order.updateCount}`,
      at: at.toISOString(),
      brokerOrderId: order.brokerOrderId,
      clientOrderId: order.request.clientOrderId,
    };
    await this.options.store.appendUpdate(order.request.accountId, update);
  }
}

function validate(r: BrokerOrderRequest) {
  const reject = (code: string, message: string) => {
    throw new BrokerRejectedError(code, message);
  };
  if (!PAPER_CAPABILITIES.orderTypes.includes(r.orderType))
    reject('order_type', 'This order type is not supported');
  if (!PAPER_CAPABILITIES.timeInForce.includes(r.timeInForce))
    reject('time_in_force', 'This time in force is not supported');
  if (r.extendedHours) reject('extended_hours', 'Extended-hours trading is not supported');
  const q = new Decimal(r.quantity);
  if (!q.isFinite() || q.lte(0)) reject('quantity', 'Quantity must be greater than zero');
  if (!q.isInteger()) reject('fractional', 'Fractional quantities are not supported');
  if ((r.orderType === 'limit' || r.orderType === 'stop_limit') && !r.limitPrice)
    reject('limit_price', 'A limit price is required');
  if ((r.orderType === 'stop' || r.orderType === 'stop_limit') && !r.stopPrice)
    reject('stop_price', 'A stop price is required');
  for (const p of [r.limitPrice, r.stopPrice]) {
    if (p !== undefined && !new Decimal(p).gt(0)) reject('price', 'Prices must be positive');
  }
}

/** Close of the session an order placed at `now` first trades in. */
function sessionCloseFor(now: Date): string | undefined {
  let day = nyDate(now.toISOString());
  for (let i = 0; i < 10; i++) {
    const s = regularSession(day);
    if (s && now.getTime() < Date.parse(s.close)) return s.close;
    day = nextTradingDay(day);
  }
  return undefined;
}
