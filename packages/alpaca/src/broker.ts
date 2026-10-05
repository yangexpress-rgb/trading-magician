import {
  BrokerRejectedError,
  type BrokerAccountBalance,
  type BrokerAdapter,
  type BrokerCapabilities,
  type BrokerOrderRequest,
  type BrokerOrderUpdate,
  type BrokerPosition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { AlpacaRequestError, type AlpacaClient } from './client';
import type { AlpacaAccount, AlpacaFillActivity, AlpacaOrder, AlpacaPosition } from './types';

/**
 * The Alpaca paper broker behind the app's broker contract (§8.2–8.5, §9.3;
 * ADR 0017). One adapter serves one Alpaca paper account, the one its key
 * belongs to. Order states come from the order list and fills from the
 * account's fill activities, each with Alpaca's own id, so repeats are
 * harmless. The update cursor is opaque to the app: the last fill activity
 * read and the newest order change seen.
 */

export const ALPACA_BROKER_ID = 'alpaca-paper';

export interface AlpacaBrokerOptions {
  client: AlpacaClient;
  capabilities: BrokerCapabilities;
  /** The app's instrument for an Alpaca symbol, for positions. */
  instrumentIdFor?: ((symbol: string) => Promise<string | undefined>) | undefined;
}

const ORDERS_PAGE = 500;
const FILLS_PAGE = 100;

interface Cursor {
  f?: string | undefined;
  s?: string | undefined;
}

/** Alpaca timestamps have up to nanoseconds; pad them so they compare as strings. */
export function timestampKey(t: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(t);
  if (m) return `${m[1]}.${(m[2] ?? '').padEnd(9, '0').slice(0, 9)}Z`;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return t;
  return `${d.toISOString().slice(0, 19)}.${String(d.getUTCMilliseconds()).padStart(3, '0')}000000Z`;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ f: c.f ?? null, s: c.s ?? null })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): Cursor {
  if (cursor === undefined) return {};
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      f?: unknown;
      s?: unknown;
    };
    const f = typeof raw.f === 'string' ? raw.f : undefined;
    const s = typeof raw.s === 'string' ? raw.s : undefined;
    return { f, s };
  } catch {
    throw new BrokerRejectedError('bad_cursor', 'The update cursor is not valid');
  }
}

/** The normalized events an order's current state implies; fills come separately. */
export function orderEvents(o: AlpacaOrder): BrokerOrderUpdate[] {
  const base = { brokerOrderId: o.id, clientOrderId: o.client_order_id };
  if (o.status === 'pending_new') return [];
  if (o.status === 'rejected') {
    return [
      {
        ...base,
        eventId: `${o.id}:rejected`,
        kind: 'rejected',
        rawStatus: o.status,
        at: o.failed_at ?? o.updated_at,
        reason: 'Alpaca rejected the order',
      },
    ];
  }
  const events: BrokerOrderUpdate[] = [
    {
      ...base,
      eventId: `${o.id}:accepted`,
      kind: 'accepted',
      rawStatus: 'accepted',
      at: o.submitted_at,
    },
  ];
  if (o.status === 'canceled' || o.status === 'replaced') {
    events.push({
      ...base,
      eventId: `${o.id}:canceled`,
      kind: 'canceled',
      rawStatus: o.status,
      at: o.canceled_at ?? o.replaced_at ?? o.updated_at,
      reason: o.status === 'replaced' ? 'Replaced at Alpaca' : 'Canceled at Alpaca',
    });
  } else if (o.status === 'expired') {
    events.push({
      ...base,
      eventId: `${o.id}:expired`,
      kind: 'expired',
      rawStatus: o.status,
      at: o.expired_at ?? o.updated_at,
      reason: 'Expired at Alpaca',
    });
  }
  return events;
}

function fillEvent(a: AlpacaFillActivity, clientOrderId: string): BrokerOrderUpdate {
  return {
    brokerOrderId: a.order_id,
    clientOrderId,
    eventId: a.id,
    kind: 'fill',
    rawStatus: a.type,
    at: a.transaction_time,
    fill: { quantity: a.qty, price: a.price, fee: '0' },
  };
}

function validate(r: BrokerOrderRequest, caps: BrokerCapabilities) {
  const reject = (code: string, message: string) => {
    throw new BrokerRejectedError(code, message);
  };
  if (!caps.orderTypes.includes(r.orderType))
    reject('order_type', 'This order type is not supported');
  if (!caps.timeInForce.includes(r.timeInForce))
    reject('time_in_force', 'This time in force is not supported');
  if (
    r.extendedHours &&
    !(caps.extendedHours && r.orderType === 'limit' && r.timeInForce === 'day')
  )
    reject('extended_hours', 'Alpaca takes extended-hours orders as day limit orders only');
  if (r.short && !caps.shortSelling) reject('short', 'This account cannot sell short');
  const q = new Decimal(r.quantity);
  if (!q.isFinite() || q.lte(0)) reject('quantity', 'Quantity must be greater than zero');
  if (!caps.fractionalQuantities && !q.isInteger())
    reject('fractional', 'Fractional quantities are not supported');
  if ((r.orderType === 'limit' || r.orderType === 'stop_limit') && !r.limitPrice)
    reject('limit_price', 'A limit price is required');
  if ((r.orderType === 'stop' || r.orderType === 'stop_limit') && !r.stopPrice)
    reject('stop_price', 'A stop price is required');
  for (const p of [r.limitPrice, r.stopPrice]) {
    if (p !== undefined && !new Decimal(p).gt(0)) reject('price', 'Prices must be positive');
  }
}

const isDuplicate = (e: AlpacaRequestError) =>
  e.status === 422 && /client_order_id must be unique/i.test(e.message);

export class AlpacaBroker implements BrokerAdapter {
  readonly id = ALPACA_BROKER_ID;
  readonly capabilities: BrokerCapabilities;
  private readonly client: AlpacaClient;

  constructor(private readonly options: AlpacaBrokerOptions) {
    this.client = options.client;
    this.capabilities = options.capabilities;
  }

  async submitOrder(request: BrokerOrderRequest): Promise<{ brokerOrderId: string }> {
    validate(request, this.capabilities);
    const body = {
      symbol: request.symbol,
      qty: request.quantity,
      side: request.direction,
      type: request.orderType,
      time_in_force: request.timeInForce,
      ...(request.limitPrice === undefined ? {} : { limit_price: request.limitPrice }),
      ...(request.stopPrice === undefined ? {} : { stop_price: request.stopPrice }),
      extended_hours: request.extendedHours,
      client_order_id: request.clientOrderId,
    };
    try {
      const order = await this.client.trading<AlpacaOrder>('POST', '/v2/orders', { body });
      return { brokerOrderId: order.id };
    } catch (e) {
      if (!(e instanceof AlpacaRequestError)) throw e;
      if (isDuplicate(e)) {
        const existing = await this.byClientOrderId(request.clientOrderId);
        if (existing) return { brokerOrderId: existing.id };
      }
      throw new BrokerRejectedError(e.status === 403 ? 'refused' : 'invalid', e.message);
    }
  }

  async cancelOrder(_accountId: string, brokerOrderId: string): Promise<void> {
    try {
      await this.client.trading('DELETE', `/v2/orders/${encodeURIComponent(brokerOrderId)}`);
    } catch (e) {
      if (!(e instanceof AlpacaRequestError)) throw e;
      // Already filled, canceled or expired: nothing left to cancel.
      if (e.status === 422) return;
      if (e.status === 404) throw new BrokerRejectedError('not_found', 'Alpaca has no such order');
      throw new BrokerRejectedError('invalid', e.message);
    }
  }

  async updates(_accountId: string, cursor: string | undefined) {
    const c = decodeCursor(cursor);
    const orders = await this.client.trading<AlpacaOrder[]>('GET', '/v2/orders', {
      query: { status: 'all', limit: ORDERS_PAGE, direction: 'desc', nested: false },
    });
    const byId = new Map(orders.map((o) => [o.id, o]));
    const updates: BrokerOrderUpdate[] = [];
    let s = c.s;
    for (const o of orders) {
      const key = timestampKey(o.updated_at);
      if (c.s !== undefined && key <= c.s) continue;
      updates.push(...orderEvents(o));
      if (s === undefined || key > s) s = key;
    }

    const fills = await this.client.trading<AlpacaFillActivity[]>(
      'GET',
      '/v2/account/activities/FILL',
      { query: { direction: 'asc', page_size: FILLS_PAGE, page_token: c.f } },
    );
    let f = c.f;
    for (const a of fills) {
      const clientOrderId =
        byId.get(a.order_id)?.client_order_id ?? (await this.order(a.order_id)).client_order_id;
      updates.push(fillEvent(a, clientOrderId));
      f = a.id;
    }
    if (f === c.f && s === c.s) return { updates, cursor };
    return { updates, cursor: encodeCursor({ f, s }) };
  }

  async orderUpdates(_accountId: string, brokerOrderId: string): Promise<BrokerOrderUpdate[]> {
    let o: AlpacaOrder;
    try {
      o = await this.order(brokerOrderId);
    } catch (e) {
      if (e instanceof AlpacaRequestError && e.status === 404) {
        throw new BrokerRejectedError('not_found', 'Alpaca has no such order');
      }
      throw e;
    }
    const updates = orderEvents(o);
    const filled = new Decimal(o.filled_qty || 0);
    if (filled.gt(0)) {
      let seen = new Decimal(0);
      let pageToken: string | undefined;
      const after = new Date(Date.parse(o.submitted_at) - 1_000).toISOString();
      for (let page = 0; page < 50 && seen.lt(filled); page++) {
        const activities = await this.client.trading<AlpacaFillActivity[]>(
          'GET',
          '/v2/account/activities/FILL',
          { query: { direction: 'asc', page_size: FILLS_PAGE, after, page_token: pageToken } },
        );
        for (const a of activities) {
          if (a.order_id !== o.id) continue;
          updates.push(fillEvent(a, o.client_order_id));
          seen = seen.plus(a.qty);
        }
        if (activities.length < FILLS_PAGE) break;
        pageToken = activities.at(-1)?.id;
      }
    }
    return updates;
  }

  async account(_accountId: string): Promise<BrokerAccountBalance> {
    const a = await this.client.trading<AlpacaAccount>('GET', '/v2/account');
    return { currency: a.currency, cash: a.cash, equity: a.equity };
  }

  async positions(_accountId: string): Promise<BrokerPosition[]> {
    const rows = await this.client.trading<AlpacaPosition[]>('GET', '/v2/positions');
    const out: BrokerPosition[] = [];
    for (const p of rows) {
      const size = new Decimal(p.qty).abs();
      const instrumentId = (await this.options.instrumentIdFor?.(p.symbol)) ?? `alpaca:${p.symbol}`;
      out.push({
        instrumentId,
        quantity: (p.side === 'short' ? size.neg() : size).toString(),
        averageCost: p.avg_entry_price,
      });
    }
    return out;
  }

  private order(id: string) {
    return this.client.trading<AlpacaOrder>('GET', `/v2/orders/${encodeURIComponent(id)}`);
  }

  private async byClientOrderId(clientOrderId: string): Promise<AlpacaOrder | undefined> {
    try {
      return await this.client.trading<AlpacaOrder>('GET', '/v2/orders:by_client_order_id', {
        query: { client_order_id: clientOrderId },
      });
    } catch (e) {
      if (e instanceof AlpacaRequestError && e.status === 404) return undefined;
      throw e;
    }
  }
}
