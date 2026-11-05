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
