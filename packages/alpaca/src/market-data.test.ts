import { inspect } from 'node:util';
import { describeHistoryContract, describeLiveQuoteContract } from '@tm/market-data/testing';
import { describe, expect, it } from 'vitest';
import { discoverAlpacaAccount, lookupAlpacaAsset } from './account';
import { AlpacaClient } from './client';
import { assertPaperTradingUrl, LiveEndpointError } from './endpoints';
import { checkAlpacaData, createAlpacaHistory, createAlpacaQuotes } from './market-data';
import account from './testing/fixtures/account.json';
import asset from './testing/fixtures/asset.json';
import bars from './testing/fixtures/bars.json';
import fill from './testing/fixtures/fill-activity.json';
import order from './testing/fixtures/order.json';
import position from './testing/fixtures/position.json';
import snapshot from './testing/fixtures/snapshot.json';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from './testing';

function setup(now: { t: Date }, credentials?: { keyId: string; secretKey: string }) {
  const fake = new FakeAlpaca({ now: () => now.t });
  const client = new AlpacaClient({
    credentials: credentials ?? fake.credentials,
    fetch: fake.fetch,
    tradingUrl: FAKE_ALPACA_TRADING_URL,
    dataUrl: FAKE_ALPACA_DATA_URL,
    allowLocal: true,
  });
  return { fake, client };
}

describeLiveQuoteContract('Alpaca IEX (fake)', async () => {
  const now = { t: new Date() };
  const { client } = setup(now);
  return {
    provider: createAlpacaQuotes(client, { now: () => now.t }),
    instrument: { instrumentId: 'i-1', symbol: 'ZTSTA' },
    setNow: (at) => (now.t = at),
  };
});

describeHistoryContract('Alpaca IEX bars (fake)', async () => {
  const now = { t: new Date('2026-10-05T00:00:00Z') };
  const { client } = setup(now);
  return {
    provider: createAlpacaHistory(client, { now: () => now.t }),
    instrument: { instrumentId: 'i-1', symbol: 'ZTSTA', assetClass: 'stock' },
  };
});

describe('Alpaca endpoints', () => {
  it('refuses the live trading host and anything but paper', () => {
    expect(() => assertPaperTradingUrl('https://api.alpaca.markets')).toThrow(LiveEndpointError);
    expect(() => assertPaperTradingUrl('https://broker-api.alpaca.markets')).toThrow(
      LiveEndpointError,
    );
    expect(() => assertPaperTradingUrl('https://example.test')).toThrow(LiveEndpointError);
    expect(() => assertPaperTradingUrl(FAKE_ALPACA_TRADING_URL)).toThrow(LiveEndpointError);
    expect(() => assertPaperTradingUrl('https://paper-api.alpaca.markets')).not.toThrow();
    expect(
      () =>
        new AlpacaClient({
          credentials: { keyId: 'k', secretKey: 's' },
          tradingUrl: 'https://api.alpaca.markets',
          allowLocal: true,
        }),
    ).toThrow(LiveEndpointError);
  });

  it('never shows the key when logged or printed', () => {
    const client = new AlpacaClient({
      credentials: { keyId: 'PKSHOULDNOTPRINT0001', secretKey: 'secret-should-not-print' },
    });
    expect(JSON.stringify(client)).not.toContain('secret-should-not-print');
    expect(inspect(client)).not.toContain('secret-should-not-print');
    expect(inspect(client)).not.toContain('PKSHOULDNOTPRINT0001');
  });
});

describe('Alpaca checks and discovery', () => {
  it('checks a working key and explains a refused one without echoing it', async () => {
    const now = { t: new Date('2026-10-06T15:00:00Z') };
    expect(await checkAlpacaData(setup(now).client)).toEqual({
      ok: true,
      entitlement: 'entitled',
      realtime: true,
    });
    const bad = await checkAlpacaData(
      setup(now, { keyId: 'PKWRONG0000000000001', secretKey: 'wrong-secret-value' }).client,
    );
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/refused the API key/);
    expect(JSON.stringify(bad)).not.toContain('wrong-secret-value');
    const { fake, client } = setup(now);
    fake.failNext(503);
    expect((await checkAlpacaData(client)).error).toBe('Alpaca is not reachable.');
  });

  it('discovers the paper account and its capabilities', async () => {
    const found = await discoverAlpacaAccount(setup({ t: new Date() }).client);
    expect(found).toMatchObject({
      displayId: '••••0042',
      environment: 'paper',
      currency: 'USD',
      tradingBlocked: false,
      assetClasses: ['stock', 'etf'],
      capabilities: {
        orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
        timeInForce: ['day', 'gtc', 'ioc', 'fok'],
        shortSelling: true,
        atomicMultiLeg: false,
      },
    });
    expect(JSON.stringify(found)).not.toContain('PA0FAKE00042');
  });

  it('looks up US stocks and ETFs by symbol', async () => {
    const { client } = setup({ t: new Date() });
    expect(await lookupAlpacaAsset(client, ' ztsta ')).toMatchObject({
      symbol: 'ZTSTA',
      assetClass: 'stock',
      venue: 'NASDAQ',
    });
    expect(await lookupAlpacaAsset(client, 'ZTSTX')).toMatchObject({ assetClass: 'etf' });
    expect(await lookupAlpacaAsset(client, 'NOSUCH')).toBeUndefined();
    expect(await lookupAlpacaAsset(client, '../v2/account')).toBeUndefined();
  });
});

describe('fake Alpaca fidelity', () => {
  const keys = (o: object) => Object.keys(o).sort();

  it('answers with the same fields as Alpaca’s documented responses', async () => {
    const now = { t: new Date('2026-10-06T15:00:00Z') };
    const { fake, client } = setup(now);
    expect(keys(await client.trading<object>('GET', '/v2/account'))).toEqual(keys(account));
    expect(keys(await client.trading<object>('GET', '/v2/assets/ZTSTA'))).toEqual(keys(asset));
    const placed = await client.trading<object>('POST', '/v2/orders', {
      body: { symbol: 'ZTSTA', qty: '2', side: 'buy', type: 'market', time_in_force: 'day' },
    });
    expect(keys(placed)).toEqual(keys(order));
    now.t = new Date(now.t.getTime() + 5_000);
    await fake.tick();
    const [activity] = await client.trading<object[]>('GET', '/v2/account/activities/FILL');
    expect(keys(activity!)).toEqual(keys(fill));
    const [held] = await client.trading<object[]>('GET', '/v2/positions');
    expect(keys(held!)).toEqual(keys(position));
    const snap = await client.data<typeof snapshot>('/v2/stocks/ZTSTA/snapshot');
    expect(keys(snap)).toEqual(keys(snapshot));
    expect(keys(snap.latestQuote)).toEqual(keys(snapshot.latestQuote));
    expect(keys(snap.latestTrade)).toEqual(keys(snapshot.latestTrade));
    const page = await client.data<typeof bars>('/v2/stocks/bars', {
      symbols: 'ZTSTA',
      timeframe: '1Day',
      start: '2026-10-01T00:00:00Z',
      end: '2026-10-03T00:00:00Z',
    });
    expect(keys(page)).toEqual(keys(bars));
    expect(keys(page.bars.ZTSTA![0]!)).toEqual(keys(bars.bars.ZTSTA[0]!));
  });
});

describe('Alpaca throttling (v1.2 review: the S&P 500 back test)', () => {
  const throttled = (times: number) => {
    const now = { t: new Date('2026-10-05T00:00:00Z') };
    const { fake } = setup(now);
    let left = times;
    const fetch: typeof fake.fetch = (url, init) => {
      if (left-- > 0)
        return Promise.resolve(
          new Response('{"message":"too many requests"}', {
            status: 429,
            headers: { 'retry-after': '3' },
          }),
        );
      return fake.fetch(url, init);
    };
    const client = new AlpacaClient({
      credentials: fake.credentials,
      fetch,
      tradingUrl: FAKE_ALPACA_TRADING_URL,
      dataUrl: FAKE_ALPACA_DATA_URL,
      allowLocal: true,
    });
    return { client, now };
  };
  const request = {
    instrumentId: 'i-1',
    symbol: 'ZTSTA',
    assetClass: 'stock',
    interval: '1d' as const,
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
    from: '2026-09-01',
    to: '2026-09-30',
  };

  it('waits as long as Alpaca says, then carries on, when patient', async () => {
    const { client, now } = throttled(2);
    const waits: number[] = [];
    const history = createAlpacaHistory(client, {
      now: () => now.t,
      patient: true,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const series = await history.getBars(request);
    expect(series.bars.length).toBeGreaterThan(0);
    expect(waits).toEqual([3250, 3250]);
  });

  it('fails at once, saying so, when not patient (paper runs, charts)', async () => {
    const { client, now } = throttled(1);
    const history = createAlpacaHistory(client, { now: () => now.t });
    await expect(history.getBars(request)).rejects.toThrow(/over its request limit/);
  });
});

describe('Alpaca bars for many symbols (ADR 0087)', () => {
  const req = (symbol: string, interval: '1d' | '5m' | '1m' = '1d') => ({
    instrumentId: symbol,
    symbol,
    assetClass: 'stock',
    interval,
    from: '2026-09-28',
    to: '2026-10-02',
    adjustment: 'split_and_dividend' as const,
    session: 'regular' as const,
  });

  it('answers many symbols in one request, each like its own request', async () => {
    const now = { t: new Date('2026-10-05T00:00:00Z') };
    const { fake, client } = setup(now);
    const history = createAlpacaHistory(client, { now: () => now.t });
    const one = await history.getBars(req('ZTSTA'));
    const two = await history.getBars(req('ZTSTB'));
    const before = fake.requests.length;
    const many = await history.getBarsMany!([req('ZTSTA'), req('ZTSTB'), req('ZTSTA', '1m')]);
    expect(fake.requests.length - before).toBe(1);
    expect(fake.requests.at(-1)?.url).toContain('symbols=ZTSTA%2CZTSTB');
    expect(many[0]).toEqual(one);
    expect(many[1]).toEqual(two);
    expect(many[2]).toBeInstanceOf(Error);
    expect(one.bars.length).toBe(5);
  });

  it('a batch of 5-minute bars pages through like one symbol', async () => {
    const now = { t: new Date('2026-10-05T00:00:00Z') };
    const { client } = setup(now);
    const history = createAlpacaHistory(client, { now: () => now.t });
    const [a] = await history.getBarsMany!([req('ZTSTA', '5m'), req('ZTSTB', '5m')]);
    expect(a).toEqual(await history.getBars(req('ZTSTA', '5m')));
  });
});

describe('Alpaca quotes for many symbols (ADR 0087)', () => {
  it('answers many symbols in one snapshots request, each like its own', async () => {
    const now = { t: new Date('2026-10-06T15:00:00Z') };
    const { fake, client } = setup(now);
    const quotes = createAlpacaQuotes(client, { now: () => now.t });
    const a = { instrumentId: 'i-a', symbol: 'ZTSTA' };
    const b = { instrumentId: 'i-b', symbol: 'ZTSTB' };
    const none = { instrumentId: 'i-x', symbol: 'NOPE' };
    const one = await quotes.latestQuote(a);
    const before = fake.requests.length;
    const many = await quotes.latestQuotes!([a, b, none]);
    expect(fake.requests.length - before).toBe(1);
    expect(many.get('i-a')?.last.toString()).toBe(one?.last.toString());
    expect(many.get('i-b')?.symbol).toBe('ZTSTB');
    expect(many.has('i-x')).toBe(false);
  });
});
