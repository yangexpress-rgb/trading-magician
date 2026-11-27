import { MemoryPaperBrokerStore, PaperBroker } from '@tm/broker';
import {
  BrokerRejectedError,
  deriveBrokerOrder,
  NYSE_ZONE,
  nyDate,
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
  AlpacaOptionContract,
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
  /** The account's options approval level (ADR 0123); absent means the account doesn't say. */
  optionsLevel?: number;
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
  /** Set once the order was replaced (a re-price): the order that replaced it. */
  replacedBy?: string;
  positionIntent?: string;
}

/** A multi-leg options order in the fake (ADR 0123 Phase O2). */
interface ComboMeta {
  id: string;
  clientOrderId: string;
  /** Sets. */
  qty: string;
  /** Net per share: positive a debit, negative a credit. */
  limitPrice: string;
  timeInForce: string;
  legs: {
    id: string;
    symbol: string;
    ratio: number;
    side: 'buy' | 'sell';
    positionIntent: string;
  }[];
  status: 'new' | 'filled' | 'canceled' | 'expired' | 'replaced';
  createdAt: string;
  updatedAt: string;
  replacedBy?: string;
  /** Each leg's fill price per share, once filled. */
  prices?: Record<string, string>;
}

/** An options contract's quote in the fake; `fillAtMid` lets a limit at the mid fill. */
interface FakeOptionQuote {
  bid: string;
  ask: string;
  at?: string;
  fillAtMid?: boolean;
}

/** OCC option symbols (root, yymmdd, C/P, strike × 1000). */
const OCC = /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/;
const isOcc = (symbol: string) => OCC.test(symbol);
/** What one unit moves cash by: 100 shares a contract (ADR 0123). */
const unitsOf = (symbol: string) => (isOcc(symbol) ? 100 : 1);

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
  private optionsLevel: number | undefined;
  private readonly optionContracts: AlpacaOptionContract[] = [];
  private readonly optionQuoteMap = new Map<string, FakeOptionQuote>();
  private readonly optionDeltaMap = new Map<string, number>();
  private readonly dividends: { symbol: string; ex_date: string; rate: number }[] = [];
  private readonly combos = new Map<string, ComboMeta>();
  /** Cash moved outside fills: assignment and exercise at the strike (Phase O2). */
  private cashAdjust = new Decimal(0);
  /** Non-trade options activities (OPASN, OPEXC, OPEXP), as Alpaca posts them the next day. */
  private readonly optionActivities: {
    id: string;
    activity_type: 'OPASN' | 'OPEXC' | 'OPEXP';
    date: string;
    symbol: string;
    qty: string;
    /** When the fake makes it readable: Alpaca posts these at the start of the next day. */
    postedAt: number;
  }[] = [];
  /** Test hooks: refuse the next combo order, or every combo close (Alpaca's uncovered-short rule). */
  private refuseNextCombo: string | undefined;
  private refuseComboCloses = false;

  constructor(options: FakeAlpacaOptions) {
    this.optionsLevel = options.optionsLevel;
    this.now = options.now;
    this.keyId = options.keyId ?? 'PKFAKEKEYID000000001';
    this.secretKey = options.secretKey ?? 'fake-secret-key-for-tests-only-0001';
    this.shortingEnabled = options.shortingEnabled ?? true;
    this.demoQuotes = createDemoLiveFeed({ now: this.now });
    const quotes: LiveQuoteProvider = {
      id: 'fake-alpaca',
      latestQuote: (ref) => {
        if (isOcc(ref.symbol)) return Promise.resolve(this.optionAsQuote(ref));
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

  /** The account's options approval level, as Alpaca reports it (ADR 0123). */
  setOptionsLevel(level: number | undefined) {
    this.optionsLevel = level;
  }

  /** Lists contracts, as `/v2/options/contracts` returns them; defaults are standard. */
  addOptionContracts(contracts: readonly Partial<AlpacaOptionContract>[]) {
    for (const c of contracts) {
      const occ = /^([A-Z.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(c.symbol ?? '');
      if (!occ) throw new Error(`not an OCC symbol: ${c.symbol}`);
      const root = occ[1]!;
      this.optionContracts.push({
        id: crypto.randomUUID(),
        symbol: c.symbol!,
        name: c.symbol!,
        status: 'active',
        tradable: true,
        expiration_date: `20${occ[2]}-${occ[3]}-${occ[4]}`,
        root_symbol: root,
        underlying_symbol: root,
        type: occ[5] === 'C' ? 'call' : 'put',
        style: 'american',
        strike_price: String(Number(occ[6]) / 1000),
        multiplier: '100',
        size: '100',
        deliverables: [{ type: 'equity', symbol: root, amount: '100' }],
        ...c,
      });
    }
  }

  /** Sets a contract's quote. With `fillAtMid`, a limit at the mid or better fills at once. */
  /** Phase O2 (§7.5): a cash dividend Alpaca's corporate actions announce. */
  setDividend(symbol: string, exDate: string, rate: string) {
    this.dividends.push({ symbol, ex_date: exDate, rate: Number(rate) });
  }

  /** Phase O2: the delta the options snapshot reports for a contract (none when unset). */
  setOptionDelta(symbol: string, delta: number | undefined) {
    if (delta === undefined) this.optionDeltaMap.delete(symbol);
    else this.optionDeltaMap.set(symbol, delta);
  }

  setOptionQuote(symbol: string, quote: FakeOptionQuote) {
    this.optionQuoteMap.set(symbol, quote);
  }

  /** The next combo order is refused with this message (A4). */
  rejectNextCombo(message = 'order rejected') {
    this.refuseNextCombo = message;
  }

  /** Every combo close is refused, as Alpaca refuses closes that would leave a short uncovered. */
  setRefuseComboCloses(on: boolean) {
    this.refuseComboCloses = on;
  }

  /**
   * Assigns a short contract (Phase O2): the contract leaves the account and
   * 100 shares a contract are delivered at the strike — bought for a put, sold
   * for a call. Alpaca posts the OPASN activity only the next day.
   */
  async assignOption(symbol: string, underlying: string) {
    const held = (await this.broker.positions(ACCOUNT)).find((p) => p.instrumentId === symbol);
    if (!held || !new Decimal(held.quantity).lt(0)) return;
    const contracts = new Decimal(held.quantity).abs();
    const strike = new Decimal(symbol.slice(-8)).div(1000);
    const put = symbol.slice(-9, -8) === 'P';
    const shares = contracts.times(100);
    await this.setHeld(symbol, new Decimal(0), undefined);
    const stock = (await this.broker.positions(ACCOUNT)).find((p) => p.instrumentId === underlying);
    const before = new Decimal(stock?.quantity ?? 0);
    const after = put ? before.plus(shares) : before.minus(shares);
    await this.setHeld(underlying, after, strike.toString());
    this.cashAdjust = put
      ? this.cashAdjust.minus(strike.times(shares))
      : this.cashAdjust.plus(strike.times(shares));
    const now = this.now();
    this.optionActivities.push({
      id: `opasn-${++this.seq}`,
      activity_type: 'OPASN',
      date: now.toISOString().slice(0, 10),
      symbol,
      qty: contracts.toString(),
      postedAt: Date.parse(`${now.toISOString().slice(0, 10)}T23:59:59Z`) + 1,
    });
  }

  private async setHeld(symbol: string, quantity: Decimal, averageCost: string | undefined) {
    await (
      this.broker as unknown as {
        options: { store: { setPosition: (a: string, p: unknown) => Promise<void> } };
      }
    ).options.store.setPosition(ACCOUNT, {
      instrumentId: symbol,
      quantity: quantity.toString(),
      averageCost: quantity.isZero() ? undefined : averageCost,
    });
  }

  /** Removes a contract from the account, as Alpaca does after expiry. */
  async expireOption(symbol: string) {
    const held = (await this.broker.positions(ACCOUNT)).find((p) => p.instrumentId === symbol);
    if (!held) return;
    await (
      this.broker as unknown as {
        options: { store: { setPosition: (a: string, p: unknown) => Promise<void> } };
      }
    ).options.store.setPosition(ACCOUNT, {
      instrumentId: symbol,
      quantity: '0',
      averageCost: undefined,
    });
  }

  private optionAsQuote(ref: { instrumentId: string; symbol: string }) {
    const q = this.optionQuoteMap.get(ref.symbol);
    if (!q) return undefined;
    const bid = new Decimal(q.bid);
    const ask = new Decimal(q.ask);
    const mid = bid.plus(ask).div(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const now = this.now();
    return {
      instrumentId: ref.instrumentId,
      symbol: ref.symbol,
      bid: q.fillAtMid ? mid : bid,
      ask: q.fillAtMid ? mid : ask,
      last: mid,
      size: new Decimal(1000),
      at: q.at ?? now.toISOString(),
      receivedAt: now.toISOString(),
      source: 'fake-alpaca',
      marketOpen: isRegularSessionOpen(now),
    };
  }

  /** Lets resting orders trade at the current time. */
  async tick() {
    await this.broker.tick();
    await this.sync();
    for (const c of this.combos.values()) await this.tryFillCombo(c);
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
    if (method === 'GET' && path === '/v2/options/contracts') {
      return json(200, this.listContracts(q));
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
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.order_class === 'mleg') return this.submitCombo(body);
      return this.submit(body);
    }
    if (method === 'GET' && path === '/v2/orders') {
      return json(200, await this.listOrders(q));
    }
    if (method === 'GET' && path === '/v2/orders:by_client_order_id') {
      const meta = [...this.orders.values()].find(
        (o) => o.clientOrderId === q.get('client_order_id'),
      );
      if (meta) return json(200, await this.order(meta));
      const combo = [...this.combos.values()].find(
        (c) => c.clientOrderId === q.get('client_order_id'),
      );
      return combo ? json(200, this.comboOrder(combo)) : json(404, errors.notFound);
    }
    const one = /^\/v2\/orders\/([^/]+)$/.exec(path);
    const combo = one ? this.combos.get(decodeURIComponent(one[1]!)) : undefined;
    if (combo) {
      if (method === 'GET') return json(200, this.comboOrder(combo));
      if (method === 'PATCH') return this.replaceCombo(combo, JSON.parse(String(init.body)));
      if (method === 'DELETE') {
        if (combo.status !== 'new') return json(422, errors.notCancelable);
        combo.status = 'canceled';
        combo.updatedAt = this.stamp();
        return json(204, null);
      }
    }
    if (one) {
      const meta = this.orders.get(decodeURIComponent(one[1]!));
      if (!meta) return json(404, errors.notFound);
      if (method === 'GET') return json(200, await this.order(meta));
      if (method === 'PATCH') return this.replace(meta, JSON.parse(String(init.body)));
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
    if (method === 'GET' && path === '/v2/account/activities') {
      const types = (q.get('activity_types') ?? '').split(',').filter(Boolean);
      const t = this.now().getTime();
      return json(
        200,
        this.optionActivities.filter(
          (x) => x.postedAt <= t && (types.length === 0 || types.includes(x.activity_type)),
        ),
      );
    }
    return json(404, { message: 'not found' });
  };

  /** Cash moves with every fill; equity marks what is held at the latest price. */
  private async account(): Promise<AlpacaAccount> {
    let cash = new Decimal(accountFixture.cash);
    for (const a of this.activities) {
      const value = new Decimal(a.price).times(a.qty).times(unitsOf(a.symbol));
      cash = a.side === 'buy' ? cash.minus(value) : cash.plus(value);
    }
    let held = new Decimal(0);
    for (const p of await this.broker.positions(ACCOUNT)) {
      const asset = FAKE_ALPACA_ASSETS[p.instrumentId];
      const quote = isOcc(p.instrumentId)
        ? this.optionAsQuote({ instrumentId: p.instrumentId, symbol: p.instrumentId })
        : asset
          ? await this.demoQuotes.latestQuote({ instrumentId: p.instrumentId, symbol: asset.demo })
          : undefined;
      held = held.plus(
        new Decimal(p.quantity)
          .times(quote?.last ?? p.averageCost ?? 0)
          .times(unitsOf(p.instrumentId)),
      );
    }
    cash = cash.plus(this.cashAdjust);
    return {
      ...accountFixture,
      ...(this.optionsLevel !== undefined
        ? {
            options_approved_level: this.optionsLevel,
            options_trading_level: this.optionsLevel,
          }
        : {}),
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
    if (isOcc(symbol)) {
      if (!this.optionContracts.some((c) => c.symbol === symbol))
        return json(422, { code: 40010001, message: `asset "${symbol}" not found` });
      if ((this.optionsLevel ?? 0) < 2)
        return json(403, { code: 40310000, message: 'account not eligible to trade options' });
      if ((str('type') ?? 'market') !== 'limit' && (str('type') ?? 'market') !== 'market')
        return json(422, { code: 42210000, message: 'invalid order type for options' });
      if (body.extended_hours === true)
        return json(422, { code: 42210000, message: 'options do not trade extended hours' });
      const pi = str('position_intent');
      const side0 = str('side');
      if (pi && !(side0 === 'buy' ? /^buy_to_(open|close)$/ : /^sell_to_(open|close)$/).test(pi))
        return json(422, { code: 42210000, message: 'position_intent does not match side' });
    } else if (!FAKE_ALPACA_ASSETS[symbol]) {
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
    // Alpaca keeps one net position per symbol and refuses an order that would
    // take it through zero, counting what open orders already hold (N307).
    const position = new Decimal(held?.quantity ?? 0);
    const closing = side === 'sell' ? position.gt(0) : position.lt(0);
    if (closing) {
      let available = position.abs();
      for (const o of this.orders.values()) {
        if (o.symbol !== symbol || o.side !== side) continue;
        const v = await this.view(o);
        if (['submitted', 'acknowledged', 'partially_filled'].includes(v.state))
          available = available.minus(new Decimal(o.qty).minus(v.filledQuantity));
      }
      available = Decimal.max(available, 0);
      if (new Decimal(qty).gt(available)) {
        return json(403, {
          code: 40310000,
          message: `insufficient qty available for order (requested: ${qty}, available: ${available.toString()})`,
        });
      }
    }
    const short = side === 'sell' && position.lt(qty);
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
      ...(str('position_intent') ? { positionIntent: str('position_intent')! } : {}),
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
    const status: AlpacaOrder['status'] = meta.replacedBy
      ? 'replaced'
      : v.state === 'filled'
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
      replaced_at: meta.replacedBy ? meta.updatedAt : null,
      ...(meta.replacedBy ? { replaced_by: meta.replacedBy } : {}),
      asset_id: FAKE_ALPACA_ASSETS[meta.symbol]?.id ?? meta.symbol,
      symbol: meta.symbol,
      asset_class: isOcc(meta.symbol) ? 'us_option' : 'us_equity',
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
    const all = [
      ...(await Promise.all([...this.orders.values()].map((m) => this.order(m)))),
      ...[...this.combos.values()].map((c) => this.comboOrder(c)),
    ];
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
          asset_class: isOcc(p.instrumentId) ? 'us_option' : 'us_equity',
          qty: qty.toString(),
          avg_entry_price: cost.toString(),
          side: qty.isNegative() ? 'short' : 'long',
          market_value: qty.times(cost).times(unitsOf(p.instrumentId)).toString(),
          cost_basis: qty.abs().times(cost).times(unitsOf(p.instrumentId)).toString(),
        };
      });
  }

  /** `/v2/options/contracts`, filtered as Alpaca filters, one page (ADR 0123). */
  private listContracts(q: URLSearchParams) {
    const underlyings = (q.get('underlying_symbols') ?? '').split(',').filter(Boolean);
    const num = (k: string) => (q.get(k) ? new Decimal(q.get(k)!) : undefined);
    const lo = num('strike_price_gte');
    const hi = num('strike_price_lte');
    const list = this.optionContracts.filter(
      (c) =>
        (underlyings.length === 0 || underlyings.includes(c.underlying_symbol ?? '')) &&
        (!q.get('status') || c.status === q.get('status')) &&
        (!q.get('expiration_date_gte') || c.expiration_date >= q.get('expiration_date_gte')!) &&
        (!q.get('expiration_date_lte') || c.expiration_date <= q.get('expiration_date_lte')!) &&
        (!lo || new Decimal(c.strike_price).gte(lo)) &&
        (!hi || new Decimal(c.strike_price).lte(hi)),
    );
    const limit = Math.min(Number(q.get('limit') ?? 100), 10_000);
    const offset = Number(q.get('page_token') ?? 0);
    const page = list
      .slice(offset, offset + limit)
      .map((c) => (q.get('show_deliverables') === 'true' ? c : { ...c, deliverables: undefined }));
    return {
      option_contracts: page,
      next_page_token: offset + limit < list.length ? String(offset + limit) : null,
    };
  }

  /** PATCH /v2/orders/{id}: Alpaca replaces the order with a new one at the new price. */
  private async replace(meta: OrderMeta, body: Record<string, unknown>): Promise<Response> {
    const view = await this.view(meta);
    if (meta.replacedBy || !['acknowledged', 'partially_filled'].includes(view.state))
      return json(422, errors.notCancelable);
    await this.broker.cancelOrder(ACCOUNT, meta.id);
    await this.sync();
    const left = new Decimal(meta.qty).minus(view.filledQuantity);
    const r = await this.submit({
      symbol: meta.symbol,
      side: meta.side,
      type: meta.type,
      time_in_force: meta.timeInForce,
      qty: typeof body.qty === 'string' ? body.qty : left.toString(),
      limit_price: typeof body.limit_price === 'string' ? body.limit_price : meta.limitPrice,
      client_order_id:
        typeof body.client_order_id === 'string' ? body.client_order_id : crypto.randomUUID(),
      ...(meta.positionIntent ? { position_intent: meta.positionIntent } : {}),
    });
    if (r.status !== 200) return r;
    const next = (await r.clone().json()) as AlpacaOrder;
    meta.replacedBy = next.id;
    meta.updatedAt = this.stamp();
    return r;
  }

  // -------------------------------------------------------------------------
  // Multi-leg options orders (ADR 0123 Phase O2)
  // -------------------------------------------------------------------------

  private async submitCombo(body: Record<string, unknown>): Promise<Response> {
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
    const clientOrderId = str('client_order_id') ?? crypto.randomUUID();
    const taken =
      [...this.orders.values()].some((o) => o.clientOrderId === clientOrderId) ||
      [...this.combos.values()].some((o) => o.clientOrderId === clientOrderId);
    if (taken) return json(422, errors.duplicate);
    if (this.refuseNextCombo) {
      const message = this.refuseNextCombo;
      this.refuseNextCombo = undefined;
      return json(422, { code: 42210000, message });
    }
    if ((this.optionsLevel ?? 0) < 3)
      return json(403, {
        code: 40310000,
        message: 'account not eligible to trade multi-leg options',
      });
    const raw = Array.isArray(body.legs) ? (body.legs as Record<string, unknown>[]) : [];
    if (raw.length < 2 || raw.length > 4)
      return json(422, { code: 42210000, message: 'mleg orders need 2 to 4 legs' });
    if (str('type') !== 'limit' || !str('limit_price'))
      return json(422, { code: 42210000, message: 'mleg orders are limit orders' });
    const legs: ComboMeta['legs'] = [];
    for (const l of raw) {
      const symbol = typeof l.symbol === 'string' ? l.symbol : '';
      const side = l.side === 'buy' || l.side === 'sell' ? l.side : undefined;
      const ratio = Number(l.ratio_qty);
      const pi = typeof l.position_intent === 'string' ? l.position_intent : '';
      if (!this.optionContracts.some((c) => c.symbol === symbol))
        return json(422, { code: 40010001, message: `asset "${symbol}" not found` });
      if (!side || !Number.isInteger(ratio) || ratio <= 0)
        return json(422, { code: 42210000, message: 'invalid leg' });
      if (!(side === 'buy' ? /^buy_to_(open|close)$/ : /^sell_to_(open|close)$/).test(pi))
        return json(422, { code: 42210000, message: 'position_intent does not match side' });
      legs.push({ id: crypto.randomUUID(), symbol, ratio, side, positionIntent: pi });
    }
    const g = legs.reduce((a, l) => {
      const f = (x: number, y: number): number => (y === 0 ? x : f(y, x % y));
      return f(a, l.ratio);
    }, 0);
    if (g !== 1)
      return json(422, { code: 42210000, message: 'leg ratios must be in lowest terms' });
    // Alpaca's rule: every short leg is covered within the order, per right.
    const right = (symbol: string) => symbol.slice(-9, -8);
    for (const r of ['C', 'P']) {
      const opening = legs.filter(
        (l) => right(l.symbol) === r && l.positionIntent.endsWith('open'),
      );
      const bought = opening.filter((l) => l.side === 'buy').reduce((n, l) => n + l.ratio, 0);
      const sold = opening.filter((l) => l.side === 'sell').reduce((n, l) => n + l.ratio, 0);
      if (sold > bought)
        return json(403, { code: 40310000, message: 'uncovered short legs are not allowed' });
    }
    if (this.refuseComboCloses && legs.some((l) => l.positionIntent.endsWith('close')))
      return json(403, {
        code: 40310000,
        message: 'closing this multi-leg order would leave a short leg uncovered',
      });
    const at = this.stamp();
    const combo: ComboMeta = {
      id: crypto.randomUUID(),
      clientOrderId,
      qty: str('qty') ?? '1',
      limitPrice: str('limit_price') ?? '0',
      timeInForce: str('time_in_force') ?? 'day',
      legs,
      status: 'new',
      createdAt: at,
      updatedAt: at,
    };
    this.combos.set(combo.id, combo);
    await this.tryFillCombo(combo);
    return json(200, this.comboOrder(combo));
  }

  /** All legs fill at their mids together, once the net mid is at or better than the limit. */
  private async tryFillCombo(c: ComboMeta) {
    if (c.status !== 'new' || !isRegularSessionOpen(this.now())) return;
    const mids: Record<string, Decimal> = {};
    let net = new Decimal(0);
    for (const l of c.legs) {
      const q = this.optionQuoteMap.get(l.symbol);
      // A leg quoted with `fillAtMid: false` holds the combo working whatever its limit.
      if (!q || q.fillAtMid === false) return;
      const mid = new Decimal(q.bid).plus(q.ask).div(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      mids[l.symbol] = mid;
      net = net.plus(mid.times(l.ratio).times(l.side === 'buy' ? 1 : -1));
    }
    if (net.gt(c.limitPrice)) return;
    const at = this.stamp();
    const sets = new Decimal(c.qty);
    for (const l of c.legs) {
      const qty = sets.times(l.ratio);
      const price = mids[l.symbol] ?? new Decimal(0);
      const held = (await this.broker.positions(ACCOUNT)).find((p) => p.instrumentId === l.symbol);
      const before = new Decimal(held?.quantity ?? 0);
      const after = l.side === 'buy' ? before.plus(qty) : before.minus(qty);
      await this.setHeld(l.symbol, after, price.toString());
      const compact = at.replace(/[-:T.Z]/g, '').slice(0, 17);
      this.activities.push({
        id: `${compact}::${String(++this.seq).padStart(8, '0')}`,
        activity_type: 'FILL',
        transaction_time: at,
        type: 'fill',
        price: price.toString(),
        qty: qty.toString(),
        side: l.side,
        symbol: l.symbol,
        leaves_qty: '0',
        order_id: l.id,
        cum_qty: qty.toString(),
        order_status: 'filled',
      });
    }
    c.prices = Object.fromEntries(Object.entries(mids).map(([k, v]) => [k, v.toString()]));
    c.status = 'filled';
    c.updatedAt = at;
  }

  private comboOrder(c: ComboMeta): AlpacaOrder {
    const filled = c.status === 'filled';
    const status: AlpacaOrder['status'] =
      c.status === 'new' ? (isRegularSessionOpen(this.now()) ? 'new' : 'accepted') : c.status;
    const base = {
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      submitted_at: c.createdAt,
      filled_at: filled ? c.updatedAt : null,
      expired_at: c.status === 'expired' ? c.updatedAt : null,
      canceled_at: c.status === 'canceled' ? c.updatedAt : null,
      failed_at: null,
      replaced_at: c.replacedBy ? c.updatedAt : null,
      ...(c.replacedBy ? { replaced_by: c.replacedBy } : {}),
      order_type: 'limit',
      type: 'limit',
      time_in_force: c.timeInForce,
      stop_price: null,
      status,
      extended_hours: false,
    };
    return {
      ...base,
      id: c.id,
      client_order_id: c.clientOrderId,
      asset_id: '',
      symbol: '',
      asset_class: 'us_option',
      qty: c.qty,
      filled_qty: filled ? c.qty : '0',
      filled_avg_price: null,
      order_class: 'mleg',
      side: 'buy',
      limit_price: c.limitPrice,
      legs: c.legs.map((l) => {
        const qty = new Decimal(c.qty).times(l.ratio).toString();
        return {
          ...base,
          id: l.id,
          client_order_id: `${c.clientOrderId}-${l.symbol}`,
          asset_id: l.symbol,
          symbol: l.symbol,
          asset_class: 'us_option',
          qty,
          filled_qty: filled ? qty : '0',
          filled_avg_price: c.prices?.[l.symbol] ?? null,
          order_class: 'mleg',
          side: l.side,
          limit_price: null,
          ratio_qty: String(l.ratio),
          position_intent: l.positionIntent,
        };
      }),
    };
  }

  private async replaceCombo(c: ComboMeta, body: Record<string, unknown>): Promise<Response> {
    if (c.status !== 'new' || c.replacedBy) return json(422, errors.notCancelable);
    c.status = 'replaced';
    const r = await this.submitCombo({
      order_class: 'mleg',
      type: 'limit',
      qty: c.qty,
      time_in_force: c.timeInForce,
      limit_price: typeof body.limit_price === 'string' ? body.limit_price : c.limitPrice,
      client_order_id:
        typeof body.client_order_id === 'string' ? body.client_order_id : crypto.randomUUID(),
      legs: c.legs.map((l) => ({
        symbol: l.symbol,
        ratio_qty: String(l.ratio),
        side: l.side,
        position_intent: l.positionIntent,
      })),
    });
    if (r.status !== 200) {
      c.status = 'new';
      return r;
    }
    const next = (await r.clone().json()) as AlpacaOrder;
    c.replacedBy = next.id;
    c.updatedAt = this.stamp();
    return r;
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
      const body = await this.snapshot(decodeURIComponent(snap[1]!));
      return body ? json(200, body) : json(404, { code: 40410000, message: 'not found' });
    }
    if (path === '/v2/stocks/snapshots') {
      // Keyed by symbol; symbols without data are left out, as Alpaca does.
      const out: Record<string, AlpacaSnapshot> = {};
      for (const symbol of (q.get('symbols') ?? '').split(',').filter(Boolean)) {
        const body = await this.snapshot(symbol);
        if (body) out[symbol] = body;
      }
      return json(200, out);
    }
    if (path === '/v2/stocks/bars') return this.bars(q);
    if (path === '/v1/corporate-actions') {
      const symbols = (q.get('symbols') ?? '').split(',');
      const from = q.get('start') ?? '0000-00-00';
      const to = q.get('end') ?? '9999-12-31';
      return json(200, {
        corporate_actions: {
          cash_dividends: this.dividends.filter(
            (d) => symbols.includes(d.symbol) && d.ex_date >= from && d.ex_date <= to,
          ),
        },
      });
    }
    if (path === '/v1beta1/options/snapshots') {
      const snapshots: Record<string, { greeks?: { delta: number } }> = {};
      for (const symbol of (q.get('symbols') ?? '').split(',').filter(Boolean)) {
        if (!this.optionQuoteMap.has(symbol) && !this.optionDeltaMap.has(symbol)) continue;
        const delta = this.optionDeltaMap.get(symbol);
        snapshots[symbol] = delta === undefined ? {} : { greeks: { delta } };
      }
      return json(200, { snapshots });
    }
    if (path === '/v1beta1/options/quotes/latest') {
      const quotes: Record<string, { ap: number; as: number; bp: number; bs: number; t: string }> =
        {};
      for (const symbol of (q.get('symbols') ?? '').split(',').filter(Boolean)) {
        const o = this.optionQuoteMap.get(symbol);
        if (!o) continue;
        quotes[symbol] = {
          ap: Number(o.ask),
          as: 10,
          bp: Number(o.bid),
          bs: 10,
          t: o.at ?? this.now().toISOString(),
        };
      }
      return json(200, { quotes });
    }
    return json(404, { message: 'not found' });
  }

  /** The latest trade and quote from the demo path, and its last two daily bars. */
  private async snapshot(symbol: string): Promise<AlpacaSnapshot | undefined> {
    const asset = FAKE_ALPACA_ASSETS[symbol];
    const quote = asset
      ? await this.demoQuotes.latestQuote({ instrumentId: symbol, symbol: asset.demo })
      : undefined;
    if (!asset || !quote) return undefined;
    const now = this.now();
    const today = nyDate(now);
    const daily = await this.barsFor(symbol, '1Day', addIsoDays(today, -10), today, 'raw');
    // Today's bar, while the session trades, is built from its finished 5-minute bars.
    const minutes = (await this.barsFor(symbol, '5Min', today, today, 'raw')).filter(
      (b) => Date.parse(b.t) + 5 * 60_000 <= now.getTime(),
    );
    const todayBar: AlpacaBar | undefined = minutes.length
      ? {
          t: new Date(zonedWallTimeToIso(`${today}T00:00`, NYSE_ZONE)!).toISOString(),
          o: minutes[0]!.o,
          h: Math.max(...minutes.map((b) => b.h)),
          l: Math.min(...minutes.map((b) => b.l)),
          c: minutes.at(-1)!.c,
          v: minutes.reduce((a, b) => a + b.v, 0),
          n: 100,
          vw: minutes.at(-1)!.c,
        }
      : undefined;
    const finished = daily.filter((b) => !todayBar || b.t < todayBar.t);
    return {
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
      minuteBar: minutes.at(-1) ?? null,
      dailyBar: todayBar ?? finished.at(-1) ?? null,
      prevDailyBar: todayBar ? (finished.at(-1) ?? null) : (finished.at(-2) ?? null),
    };
  }

  private async barsFor(
    symbol: string,
    timeframe: '1Day' | '1Hour' | '5Min',
    start: string,
    end: string,
    adjustment: string,
  ): Promise<AlpacaBar[]> {
    const asset = FAKE_ALPACA_ASSETS[symbol];
    if (!asset) return [];
    const history = createDemoHistoryProvider({ now: this.now });
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
    return series.bars.map((b) => ({
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
  }

  private async bars(q: URLSearchParams): Promise<Response> {
    const timeframe = q.get('timeframe');
    if (timeframe !== '1Day' && timeframe !== '1Hour' && timeframe !== '5Min') {
      return json(422, { code: 42210000, message: 'invalid timeframe' });
    }
    const start = (q.get('start') ?? '').slice(0, 10);
    // Alpaca's end defaults to now.
    const end = (q.get('end') ?? this.now().toISOString()).slice(0, 10);
    const adjustment = q.get('adjustment') ?? 'raw';
    // A range that starts after the fake's clock has no bars yet, as with
    // Alpaca. Callers on the real clock (the screener) can ask for one when
    // the fake runs on a shifted paper clock (E2E's PAPER_CLOCK_START).
    if (start > end) return json(200, { bars: {}, next_page_token: null });
    // Pages run through the symbols in order, each symbol's bars oldest first.
    const all: [string, AlpacaBar][] = [];
    for (const symbol of (q.get('symbols') ?? '').split(',').filter(Boolean).sort()) {
      for (const b of await this.barsFor(symbol, timeframe, start, end, adjustment)) {
        all.push([symbol, b]);
      }
    }
    const limit = Math.min(Number(q.get('limit') ?? 1000), 10_000);
    const offset = Number(q.get('page_token') ?? 0);
    const bars: Record<string, AlpacaBar[]> = {};
    for (const [symbol, b] of all.slice(offset, offset + limit)) (bars[symbol] ??= []).push(b);
    const next = offset + limit < all.length ? String(offset + limit) : null;
    return json(200, { bars, next_page_token: next });
  }
}

const addIsoDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export { ACCOUNT as FAKE_ALPACA_ACCOUNT };
