import type { BrokerOrderRequest, BrokerOrderUpdate, BrokerPosition } from '@tm/domain';

/** The simulated broker's own record of an order. */
export interface PaperOrder {
  brokerOrderId: string;
  request: BrokerOrderRequest;
  status: 'working' | 'filled' | 'canceled' | 'expired' | 'rejected';
  filled: string;
  /** Whether a stop or stop-limit order's stop price has been reached. */
  triggered: boolean;
  /** Day orders expire at the close of the session they first trade in. */
  expiresAt: string | undefined;
  acceptedAt: string;
  updateCount: number;
}

/**
 * Where the simulated broker keeps its state. It is the broker's own record,
 * separate from the app's orders, the way a real broker's is; reconciliation
 * compares the two. The memory store serves tests; the worker uses a Postgres
 * store so paper accounts survive restarts.
 */
export interface PaperBrokerStore {
  findByClientOrderId(accountId: string, clientOrderId: string): Promise<PaperOrder | undefined>;
  get(accountId: string, brokerOrderId: string): Promise<PaperOrder | undefined>;
  insert(order: PaperOrder): Promise<void>;
  save(order: PaperOrder): Promise<void>;
  working(): Promise<PaperOrder[]>;
  appendUpdate(accountId: string, update: BrokerOrderUpdate): Promise<void>;
  updatesAfter(
    accountId: string,
    cursor: number,
    limit: number,
  ): Promise<{ updates: BrokerOrderUpdate[]; cursor: number }>;
  orderUpdates(accountId: string, brokerOrderId: string): Promise<BrokerOrderUpdate[]>;
  position(accountId: string, instrumentId: string): Promise<BrokerPosition | undefined>;
  setPosition(accountId: string, position: BrokerPosition): Promise<void>;
  positions(accountId: string): Promise<BrokerPosition[]>;
}

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryPaperBrokerStore implements PaperBrokerStore {
  private readonly orders = new Map<string, PaperOrder>();
  private readonly log: { accountId: string; update: BrokerOrderUpdate }[] = [];
  private readonly held = new Map<string, BrokerPosition>();

  async findByClientOrderId(accountId: string, clientOrderId: string) {
    const o = [...this.orders.values()].find(
      (o) => o.request.accountId === accountId && o.request.clientOrderId === clientOrderId,
    );
    return o && clone(o);
  }
  async get(accountId: string, brokerOrderId: string) {
    const o = this.orders.get(brokerOrderId);
    return o && o.request.accountId === accountId ? clone(o) : undefined;
  }
  async insert(order: PaperOrder) {
    this.orders.set(order.brokerOrderId, clone(order));
  }
  async save(order: PaperOrder) {
    this.orders.set(order.brokerOrderId, clone(order));
  }
  async working() {
    return [...this.orders.values()].filter((o) => o.status === 'working').map(clone);
  }
  async appendUpdate(accountId: string, update: BrokerOrderUpdate) {
    this.log.push({ accountId, update: clone(update) });
  }
  async updatesAfter(accountId: string, cursor: number, limit: number) {
    const updates: BrokerOrderUpdate[] = [];
    let next = cursor;
    for (let i = cursor; i < this.log.length && updates.length < limit; i++) {
      const entry = this.log[i];
      next = i + 1;
      if (entry?.accountId === accountId) updates.push(clone(entry.update));
    }
    return { updates, cursor: next };
  }
  async orderUpdates(accountId: string, brokerOrderId: string) {
    return this.log
      .filter((e) => e.accountId === accountId && e.update.brokerOrderId === brokerOrderId)
      .map((e) => clone(e.update));
  }
  async position(accountId: string, instrumentId: string) {
    const p = this.held.get(`${accountId}|${instrumentId}`);
    return p && clone(p);
  }
  async setPosition(accountId: string, position: BrokerPosition) {
    this.held.set(`${accountId}|${position.instrumentId}`, clone(position));
  }
  async positions(accountId: string) {
    return [...this.held.entries()]
      .filter(([k, p]) => k.startsWith(`${accountId}|`) && p.quantity !== '0')
      .map(([, p]) => clone(p));
  }
}
