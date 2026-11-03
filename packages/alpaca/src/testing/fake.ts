import { MemoryPaperBrokerStore, PaperBroker } from '@tm/broker';
import {
  BrokerRejectedError,
  deriveBrokerOrder,
  NYSE_ZONE,
  zonedWallTimeToIso,
  type BrokerOrderUpdate,
  type LiveQuoteProvider,
} from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import Decimal from 'decimal.js';
import { isRegularSessionOpen } from '../market-data';
import type {
  AlpacaAccount,
  AlpacaAsset,
  AlpacaBar,
  AlpacaFillActivity,
  AlpacaOrder,
  AlpacaPosition,
  AlpacaSnapshot,
} from '../types';
import accountFixture from './fixtures/account.json';
import assetFixture from './fixtures/asset.json';
import errors from './fixtures/errors.json';

/**
 * A fake Alpaca for tests and E2E (ADR 0017). It answers the same REST paths
 * with the same JSON shapes as Alpaca's paper trading and market-data APIs
 * (see `fixtures/`, transcribed from Alpaca's API reference), so the adapters
 * are exercised over HTTP semantics without keys or network. Orders are
 * worked by the built-in paper broker against the demo price paths, so the
 * fake behaves like a market. Its symbols are made up.
 */

export const FAKE_ALPACA_TRADING_URL = 'fake://paper-api.alpaca.markets';
export const FAKE_ALPACA_DATA_URL = 'fake://data.alpaca.markets';

export const FAKE_ALPACA_ASSETS: Record<
  string,
  { name: string; exchange: string; demo: string; id: string }
> = {
  ZTSTA: {
    name: 'Test Alpha Inc. Common Stock',
    exchange: 'NASDAQ',
    demo: 'DEMO-A',
    id: 'b0b6dd9d-8b9b-48a9-ba46-b9d54906e415',
  },
  ZTSTB: {
    name: 'Test Beta Corp. Common Stock',
    exchange: 'NYSE',
    demo: 'DEMO-B',
    id: '1c2d3e4f-0000-4000-8000-00000000000b',
  },
  ZTSTX: {
    name: 'Test Broad Market ETF',
    exchange: 'ARCA',
    demo: 'DEMO-IDX',
    id: '1c2d3e4f-0000-4000-8000-00000000000c',
  },
};

export interface FakeAlpacaOptions {
  now: () => Date;
  /** The key the fake accepts. Any other is refused with 401. */
  keyId?: string;
  secretKey?: string;
  shortingEnabled?: boolean;
}

interface OrderMeta {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  timeInForce: string;
  qty: string;
  limitPrice: string | null;
  stopPrice: string | null;
  extendedHours: boolean;
  createdAt: string;
  updatedAt: string;
}

const ACCOUNT = 'fake-account';

function json(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class FakeAlpaca {
  readonly requests: { method: string; url: string }[] = [];
  private readonly now: () => Date;
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly shortingEnabled: boolean;
  private readonly demoQuotes: LiveQuoteProvider;
  private readonly broker: PaperBroker;
  private readonly orders = new Map<string, OrderMeta>();
  private readonly activities: AlpacaFillActivity[] = [];
  private cursor: string | undefined;
  private lastMicros = 0;
  private seq = 0;
  private failures: number[] = [];

  constructor(options: FakeAlpacaOptions) {
    this.now = options.now;
    this.keyId = options.keyId ?? 'PKFAKEKEYID000000001';
    this.secretKey = options.secretKey ?? 'fake-secret-key-for-tests-only-0001';
    this.shortingEnabled = options.shortingEnabled ?? true;
    this.demoQuotes = createDemoLiveFeed({ now: this.now });
    const quotes: LiveQuoteProvider = {
      id: 'fake-alpaca',
      latestQuote: (ref) => {
        const asset = FAKE_ALPACA_ASSETS[ref.symbol];
        return asset
          ? this.demoQuotes.latestQuote({ instrumentId: ref.instrumentId, symbol: asset.demo })
          : Promise.resolve(undefined);
      },
    };
    this.broker = new PaperBroker({
      quotes,
      store: new MemoryPaperBrokerStore(),
      now: this.now,
      newId: () => crypto.randomUUID(),
    });
  }

  get credentials() {
    return { keyId: this.keyId, secretKey: this.secretKey };
  }

  /** The next `count` requests fail with `status` (e.g. 503), then it recovers. */
  failNext(status: number, count = 1) {
    for (let i = 0; i < count; i++) this.failures.push(status);
  }

  /** Lets resting orders trade at the current time. */
  async tick() {
    await this.broker.tick();
    await this.sync();
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    this.requests.push({ method, url });
    const failure = this.failures.shift();
    if (failure) return json(failure, { message: 'unavailable' });
    const headers = new Headers(init.headers);
    if (
      headers.get('APCA-API-KEY-ID') !== this.keyId ||
      headers.get('APCA-API-SECRET-KEY') !== this.secretKey
    ) {
      return json(401, errors.unauthorized);
    }
    const u = new URL(url);
    const path = u.pathname;
    const q = u.searchParams;
    if (u.host === 'data.alpaca.markets') return this.data(path, q);
    if (u.host !== 'paper-api.alpaca.markets') return json(404, { message: 'not found' });
    await this.sync();

    if (method === 'GET' && path === '/v2/account') return json(200, await this.account());
    if (method === 'GET' && path === '/v2/clock') {
      const now = this.now();
      return json(200, {
        timestamp: now.toISOString(),
        is_open: isRegularSessionOpen(now),
        next_open: now.toISOString(),
        next_close: now.toISOString(),
      });
    }
    if (method === 'GET' && path === '/v2/assets') {
      // Every listed asset, filtered as Alpaca filters by status and class.
      const all = Object.keys(FAKE_ALPACA_ASSETS).flatMap((s) => this.asset(s) ?? []);
      return json(
        200,
        all.filter(
          (a) =>
            (!q.get('status') || a.status === q.get('status')) &&
            (!q.get('asset_class') || a.class === q.get('asset_class')),
        ),
      );
    }
    const asset = /^\/v2\/assets\/([^/]+)$/.exec(path);
    if (method === 'GET' && asset) {
      const found = this.asset(decodeURIComponent(asset[1]!));
      return found ? json(200, found) : json(404, { code: 40410000, message: 'asset not found' });
    }
    if (method === 'POST' && path === '/v2/orders') {
      return this.submit(JSON.parse(String(init.body)) as Record<string, unknown>);
    }
    if (method === 'GET' && path === '/v2/orders') {
      return json(200, await this.listOrders(q));
    }
    if (method === 'GET' && path === '/v2/orders:by_client_order_id') {
      const meta = [...this.orders.values()].find(
        (o) => o.clientOrderId === q.get('client_order_id'),
      );
      return meta ? json(200, await this.order(meta)) : json(404, errors.notFound);
    }
    const one = /^\/v2\/orders\/([^/]+)$/.exec(path);
    if (one) {
      const meta = this.orders.get(decodeURIComponent(one[1]!));
      if (!meta) return json(404, errors.notFound);
      if (method === 'GET') return json(200, await this.order(meta));
      if (method === 'DELETE') {
        const view = await this.view(meta);
        if (!['acknowledged', 'partially_filled'].includes(view.state)) {
          return json(422, errors.notCancelable);
        }
        await this.broker.cancelOrder(ACCOUNT, meta.id);
        await this.sync();
        return json(204, null);
      }
    }
    if (method === 'GET' && path === '/v2/positions') return json(200, await this.positions());
    if (method === 'GET' && path === '/v2/account/activities/FILL') {
      return json(200, this.fills(q));
    }
    return json(404, { message: 'not found' });
  };

  /** Cash moves with every fill; equity marks what is held at the latest price. */
  private async account(): Promise<AlpacaAccount> {
    let cash = new Decimal(accountFixture.cash);
    for (const a of this.activities) {
      const value = new Decimal(a.price).times(a.qty);
      cash = a.side === 'buy' ? cash.minus(value) : cash.plus(value);
    }
    let held = new Decimal(0);
    for (const p of await this.broker.positions(ACCOUNT)) {
      const asset = FAKE_ALPACA_ASSETS[p.instrumentId];
      const quote = asset
        ? await this.demoQuotes.latestQuote({ instrumentId: p.instrumentId, symbol: asset.demo })
        : undefined;
      held = held.plus(new Decimal(p.quantity).times(quote?.last ?? p.averageCost ?? 0));
    }
    return {
      ...accountFixture,
      shorting_enabled: this.shortingEnabled,
      cash: cash.toString(),
      equity: cash.plus(held).toString(),
    };
  }

  private asset(symbol: string): AlpacaAsset | undefined {
    const a = FAKE_ALPACA_ASSETS[symbol];
    if (!a) return undefined;
    return { ...assetFixture, id: a.id, symbol, name: a.name, exchange: a.exchange };
  }

  private stamp(): string {
    const micros = Math.max(this.now().getTime() * 1000, this.lastMicros + 1);
    this.lastMicros = micros;
    const base = new Date(Math.floor(micros / 1000)).toISOString().slice(0, 19);
    return `${base}.${String(micros % 1_000_000).padStart(6, '0')}Z`;
  }

  private async submit(body: Record<string, unknown>): Promise<Response> {
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    const clientOrderId = str('client_order_id') ?? crypto.randomUUID();
    if ([...this.orders.values()].some((o) => o.clientOrderId === clientOrderId)) {
      return json(422, errors.duplicate);
    }
    const symbol = str('symbol') ?? '';
    if (!FAKE_ALPACA_ASSETS[symbol]) {
      return json(422, { code: 40010001, message: `asset "${symbol}" not found` });
    }
    const side = str('side');
    const type = str('type') ?? 'market';
    const tif = str('time_in_force') ?? 'day';
    const qty = str('qty') ?? '0';
    if (side !== 'buy' && side !== 'sell') {
      return json(422, { code: 40010001, message: 'invalid side' });
    }
    if ((type === 'limit' || type === 'stop_limit') && !str('limit_price')) {
      return json(422, { code: 40010001, message: 'limit_price is required' });
    }
    if ((type === 'stop' || type === 'stop_limit') && !str('stop_price')) {
      return json(422, { code: 40010001, message: 'stop_price is required' });
    }
    const extendedHours = body.extended_hours === true;
    if (extendedHours && !(type === 'limit' && tif === 'day')) {
      return json(422, {
        code: 42210000,
        message: 'extended hours order must be DAY limit orders',
      });
    }
    const held = (await this.broker.positions(ACCOUNT)).find((p) => p.instrumentId === symbol);
    const short = side === 'sell' && new Decimal(held?.quantity ?? 0).lt(qty);
    if (short && !this.shortingEnabled) {
      return json(403, { code: 40310000, message: 'account is not allowed to short' });
    }
    let brokerOrderId: string;
    try {
      ({ brokerOrderId } = await this.broker.submitOrder({
        clientOrderId,
        accountId: ACCOUNT,
        instrumentId: symbol,
        symbol,
        direction: side,
        short,
        quantity: qty,
        orderType: type as 'market',
        limitPrice: str('limit_price'),
        stopPrice: str('stop_price'),
        timeInForce: tif as 'day',
        // The simulator has no extended session; the order simply waits for the regular one.
        extendedHours: false,
      }));
    } catch (e) {
      if (e instanceof BrokerRejectedError)
        return json(422, { code: 40010001, message: e.message });
      throw e;
    }
    const at = this.stamp();
    const meta: OrderMeta = {
      id: brokerOrderId,
      clientOrderId,
      symbol,
      side,
      type,
      timeInForce: tif,
      qty,
      limitPrice: str('limit_price') ?? null,
      stopPrice: str('stop_price') ?? null,
      extendedHours,
      createdAt: at,
      updatedAt: at,
    };
    this.orders.set(brokerOrderId, meta);
    await this.sync();
    return json(200, await this.order(meta));
  }

  /** Turns the simulator's updates into Alpaca's order changes and fill activities. */
  private async sync() {
    for (;;) {
      const page = await this.broker.updates(ACCOUNT, this.cursor);
      if (page.updates.length === 0) break;
      this.cursor = page.cursor;
      for (const u of page.updates) await this.record(u);
    }
  }

  private async record(u: BrokerOrderUpdate) {
    const meta = this.orders.get(u.brokerOrderId);
    if (!meta) return;
    const at = this.stamp();
    meta.updatedAt = at;
    if (u.kind !== 'fill' || !u.fill) return;
    const view = await this.view(meta);
    const leaves = new Decimal(meta.qty).minus(view.filledQuantity);
    const compact = at.replace(/[-:T.Z]/g, '').slice(0, 17);
    this.activities.push({
      id: `${compact}::${String(++this.seq).padStart(8, '0')}`,
      activity_type: 'FILL',
      transaction_time: at,
      type: leaves.isZero() ? 'fill' : 'partial_fill',
      price: u.fill.price,
      qty: u.fill.quantity,
      side: meta.side,
      symbol: meta.symbol,
      leaves_qty: leaves.toString(),
      order_id: meta.id,
      cum_qty: view.filledQuantity.toString(),
      order_status: leaves.isZero() ? 'filled' : 'partially_filled',
    });
  }

  private async view(meta: OrderMeta) {
    const updates = await this.broker.orderUpdates(ACCOUNT, meta.id);
    return deriveBrokerOrder(new Decimal(meta.qty), updates);
  }

  private async order(meta: OrderMeta): Promise<AlpacaOrder> {
    const v = await this.view(meta);
    const status: AlpacaOrder['status'] =
      v.state === 'filled'
        ? 'filled'
        : v.state === 'partially_filled'
          ? 'partially_filled'
          : v.state === 'canceled'
            ? 'canceled'
            : v.state === 'expired'
              ? 'expired'
              : v.state === 'rejected'
                ? 'rejected'
                : isRegularSessionOpen(this.now())
                  ? 'new'
                  : 'accepted';
    const terminal = (s: string) => (status === s ? meta.updatedAt : null);
    return {
      id: meta.id,
      client_order_id: meta.clientOrderId,
      created_at: meta.createdAt,
      updated_at: meta.updatedAt,
      submitted_at: meta.createdAt,
      filled_at: status === 'filled' ? meta.updatedAt : null,
      expired_at: terminal('expired'),
      canceled_at: terminal('canceled'),
      failed_at: terminal('rejected'),
      replaced_at: null,
      asset_id: FAKE_ALPACA_ASSETS[meta.symbol]!.id,
      symbol: meta.symbol,
      asset_class: 'us_equity',
      qty: meta.qty,
      filled_qty: v.filledQuantity.toString(),
      filled_avg_price: v.averagePrice?.toDecimalPlaces(4).toString() ?? null,
      order_class: '',
      order_type: meta.type,
      type: meta.type,
      side: meta.side,
      time_in_force: meta.timeInForce,
      limit_price: meta.limitPrice,
      stop_price: meta.stopPrice,
      status,
      extended_hours: meta.extendedHours,
    };
  }

  private async listOrders(q: URLSearchParams): Promise<AlpacaOrder[]> {
    const status = q.get('status') ?? 'open';
    const limit = Math.min(Number(q.get('limit') ?? 50), 500);
    const all = await Promise.all([...this.orders.values()].map((m) => this.order(m)));
    const open = (o: AlpacaOrder) => ['new', 'accepted', 'partially_filled'].includes(o.status);
    const chosen = all.filter((o) =>
      status === 'all' ? true : status === 'open' ? open(o) : !open(o),
    );
    chosen.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
    if ((q.get('direction') ?? 'desc') === 'desc') chosen.reverse();
    return chosen.slice(0, limit);
  }

  private async positions(): Promise<AlpacaPosition[]> {
    const held = await this.broker.positions(ACCOUNT);
    return held
      .filter((p) => !new Decimal(p.quantity).isZero())
      .map((p) => {
        const qty = new Decimal(p.quantity);
        const cost = new Decimal(p.averageCost ?? 0);
        return {
          asset_id: FAKE_ALPACA_ASSETS[p.instrumentId]?.id ?? '',
          symbol: p.instrumentId,
          exchange: FAKE_ALPACA_ASSETS[p.instrumentId]?.exchange ?? '',
          asset_class: 'us_equity',
          qty: qty.toString(),
          avg_entry_price: cost.toString(),
          side: qty.isNegative() ? 'short' : 'long',
          market_value: qty.times(cost).toString(),
          cost_basis: qty.abs().times(cost).toString(),
        };
      });
  }

  private fills(q: URLSearchParams): AlpacaFillActivity[] {
    const size = Math.min(Number(q.get('page_size') ?? 100), 100);
    const token = q.get('page_token');
    const after = q.get('after');
    let list = this.activities;
    if (after) list = list.filter((a) => a.transaction_time > after);
    if (token) list = list.filter((a) => a.id > token);
    if ((q.get('direction') ?? 'desc') === 'desc') list = [...list].reverse();
    return list.slice(0, size);
  }

  private async data(path: string, q: URLSearchParams): Promise<Response> {
    if (path === '/v2/stocks/meta/exchanges') {
      return json(200, { V: 'IEX', Q: 'NASDAQ OMX', N: 'New York Stock Exchange' });
    }
    const snap = /^\/v2\/stocks\/([^/]+)\/snapshot$/.exec(path);
    if (snap) {
      const symbol = decodeURIComponent(snap[1]!);
      const asset = FAKE_ALPACA_ASSETS[symbol];
      const quote = asset
        ? await this.demoQuotes.latestQuote({ instrumentId: symbol, symbol: asset.demo })
        : undefined;
      if (!quote) return json(404, { code: 40410000, message: 'not found' });
      const body: AlpacaSnapshot = {
        latestTrade: {
          t: quote.at,
          x: 'V',
          p: quote.last.toNumber(),
          s: 100,
          c: ['@'],
          i: ++this.seq,
          z: 'C',
        },
        latestQuote: {
          t: quote.at,
          ax: 'V',
          ap: quote.ask.toNumber(),
          as: quote.size.toNumber(),
          bx: 'V',
          bp: quote.bid.toNumber(),
          bs: quote.size.toNumber(),
          c: ['R'],
          z: 'C',
        },
        minuteBar: null,
        dailyBar: null,
        prevDailyBar: null,
      };
      return json(200, body);
    }
    if (path === '/v2/stocks/bars') return this.bars(q);
    return json(404, { message: 'not found' });
  }

  private async bars(q: URLSearchParams): Promise<Response> {
    const symbol = q.get('symbols') ?? '';
    const asset = FAKE_ALPACA_ASSETS[symbol];
    const timeframe = q.get('timeframe');
    if (timeframe !== '1Day' && timeframe !== '1Hour' && timeframe !== '5Min') {
      return json(422, { code: 42210000, message: 'invalid timeframe' });
    }
    if (!asset) return json(200, { bars: {}, next_page_token: null });
    const adjustment = q.get('adjustment') ?? 'raw';
    const history = createDemoHistoryProvider({ now: this.now });
    const start = (q.get('start') ?? '').slice(0, 10);
    const end = (q.get('end') ?? '').slice(0, 10);
    const series = await history.getBars({
      instrumentId: symbol,
      symbol: asset.demo,
      assetClass: 'stock',
      interval: timeframe === '1Day' ? '1d' : timeframe === '5Min' ? '5m' : '1h',
      from: start,
      to: end,
      adjustment:
        adjustment === 'all'
          ? 'split_and_dividend'
          : adjustment === 'split'
            ? 'split_only'
            : 'none',
      session: 'regular',
    });
    const all: AlpacaBar[] = series.bars.map((b) => ({
      t:
        timeframe === '1Day'
          ? new Date(zonedWallTimeToIso(`${b.start.slice(0, 10)}T00:00`, NYSE_ZONE)!).toISOString()
          : b.start,
      o: b.open.toNumber(),
      h: b.high.toNumber(),
      l: b.low.toNumber(),
      c: b.close.toNumber(),
      v: b.volume.toNumber(),
      n: 100,
      vw: b.close.toNumber(),
    }));
    const limit = Math.min(Number(q.get('limit') ?? 1000), 10_000);
    const offset = Number(q.get('page_token') ?? 0);
    const page = all.slice(offset, offset + limit);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    return json(200, { bars: { [symbol]: page }, next_page_token: next });
  }
}

export { ACCOUNT as FAKE_ALPACA_ACCOUNT };
