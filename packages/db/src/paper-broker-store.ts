import type { PaperBrokerStore, PaperOrder } from '@tm/broker';
import type { BrokerOrderRequest, BrokerOrderUpdate, BrokerPosition } from '@tm/domain';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Transaction } from './client';
import { paperOrders, paperPositions, paperUpdates } from './schema';

/**
 * The simulated paper broker's books in Postgres (ADR 0011), so paper accounts
 * survive worker restarts. A store works inside one tenant transaction; the
 * caller holds the tenant's paper lock (`lockPaperBroker`) so two workers never
 * fill the same order at once.
 */
export class DbPaperBrokerStore implements PaperBrokerStore {
  constructor(
    private readonly tx: Transaction,
    private readonly userId: string,
  ) {}

  private toOrder(row: typeof paperOrders.$inferSelect): PaperOrder {
    return {
      brokerOrderId: row.brokerOrderId,
      request: row.request as BrokerOrderRequest,
      status: row.status as PaperOrder['status'],
      filled: row.filled,
      triggered: row.triggered,
      expiresAt: row.expiresAt?.toISOString(),
      acceptedAt: row.acceptedAt.toISOString(),
      updateCount: row.updateCount,
    };
  }

  async findByClientOrderId(accountId: string, clientOrderId: string) {
    const [row] = await this.tx
      .select()
      .from(paperOrders)
      .where(
        and(eq(paperOrders.accountId, accountId), eq(paperOrders.clientOrderId, clientOrderId)),
      );
    return row && this.toOrder(row);
  }

  async get(accountId: string, brokerOrderId: string) {
    const [row] = await this.tx
      .select()
      .from(paperOrders)
      .where(
        and(eq(paperOrders.accountId, accountId), eq(paperOrders.brokerOrderId, brokerOrderId)),
      );
    return row && this.toOrder(row);
  }

  async insert(order: PaperOrder) {
    await this.tx.insert(paperOrders).values({
      brokerOrderId: order.brokerOrderId,
      userId: this.userId,
      accountId: order.request.accountId,
      clientOrderId: order.request.clientOrderId,
      request: order.request,
      status: order.status,
      filled: order.filled,
      triggered: order.triggered,
      expiresAt: order.expiresAt ? new Date(order.expiresAt) : null,
      acceptedAt: new Date(order.acceptedAt),
      updateCount: order.updateCount,
    });
  }

  async save(order: PaperOrder) {
    await this.tx
      .update(paperOrders)
      .set({
        status: order.status,
        filled: order.filled,
        triggered: order.triggered,
        updateCount: order.updateCount,
      })
      .where(eq(paperOrders.brokerOrderId, order.brokerOrderId));
  }

  async working() {
    const rows = await this.tx
      .select()
      .from(paperOrders)
      .where(eq(paperOrders.status, 'working'))
      .orderBy(asc(paperOrders.acceptedAt));
    return rows.map((r) => this.toOrder(r));
  }

  async appendUpdate(accountId: string, update: BrokerOrderUpdate) {
    await this.tx.insert(paperUpdates).values({
      userId: this.userId,
      accountId,
      brokerOrderId: update.brokerOrderId,
      update,
    });
  }

  async updatesAfter(accountId: string, cursor: number, limit: number) {
    const rows = await this.tx
      .select({ seq: paperUpdates.seq, update: paperUpdates.update })
      .from(paperUpdates)
      .where(and(eq(paperUpdates.accountId, accountId), gt(paperUpdates.seq, cursor)))
      .orderBy(asc(paperUpdates.seq))
      .limit(limit);
    return {
      updates: rows.map((r) => r.update as BrokerOrderUpdate),
      cursor: rows.at(-1)?.seq ?? cursor,
    };
  }

  async orderUpdates(accountId: string, brokerOrderId: string) {
    const rows = await this.tx
      .select({ update: paperUpdates.update })
      .from(paperUpdates)
      .where(
        and(eq(paperUpdates.accountId, accountId), eq(paperUpdates.brokerOrderId, brokerOrderId)),
      )
      .orderBy(asc(paperUpdates.seq));
    return rows.map((r) => r.update as BrokerOrderUpdate);
  }

  async position(accountId: string, instrumentId: string) {
    const [row] = await this.tx
      .select()
      .from(paperPositions)
      .where(
        and(eq(paperPositions.accountId, accountId), eq(paperPositions.instrumentId, instrumentId)),
      );
    return row && toPosition(row);
  }

  async setPosition(accountId: string, position: BrokerPosition) {
    await this.tx
      .insert(paperPositions)
      .values({
        userId: this.userId,
        accountId,
        instrumentId: position.instrumentId,
        quantity: position.quantity,
        averageCost: position.averageCost ?? null,
      })
      .onConflictDoUpdate({
        target: [paperPositions.accountId, paperPositions.instrumentId],
        set: { quantity: position.quantity, averageCost: position.averageCost ?? null },
      });
  }

  async positions(accountId: string) {
    const rows = await this.tx
      .select()
      .from(paperPositions)
      .where(eq(paperPositions.accountId, accountId));
    return rows.filter((r) => Number(r.quantity) !== 0).map(toPosition);
  }
}

function toPosition(row: typeof paperPositions.$inferSelect): BrokerPosition {
  return {
    instrumentId: row.instrumentId,
    quantity: row.quantity,
    averageCost: row.averageCost ?? undefined,
  };
}
