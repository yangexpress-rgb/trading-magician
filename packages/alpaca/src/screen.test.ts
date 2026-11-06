import { describe, expect, it } from 'vitest';
import { AlpacaClient, AlpacaUnavailableError } from './client';
import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from './testing';
import { chunk, fetchDailyHistory, fetchSnapshots, screenSource, screenUniverse } from './screen';
import type { DiscoveredInstrument } from './account';

// Tuesday 2026-10-06, 11:00 in New York: the session is trading.
const NOW = new Date('2026-10-06T15:00:00Z');

function setup() {
  const fake = new FakeAlpaca({ now: () => NOW });
  const client = new AlpacaClient({
    credentials: fake.credentials,
    fetch: fake.fetch,
    tradingUrl: FAKE_ALPACA_TRADING_URL,
    dataUrl: FAKE_ALPACA_DATA_URL,
    allowLocal: true,
  });
  return { fake, client };
}

const asset = (symbol: string, venue = 'NASDAQ', tradable = true): DiscoveredInstrument => ({
  symbol,
  displayName: `${symbol} Inc.`,
  assetClass: 'stock',
  venue,
  providerId: symbol,
  tradable,
  shortable: true,
});

describe('screening with Alpaca', () => {
  it('covers tradable listings on the main exchanges only', () => {
    const kept = screenUniverse([
      asset('AAA'),
      asset('BBB', 'OTC'),
      asset('CCC', 'NYSE', false),
      asset('DDD', 'ARCA'),
    ]);
    expect(kept.map((a) => a.symbol)).toEqual(['AAA', 'DDD']);
  });

  it('asks for many symbols at once', async () => {
    const { fake, client } = setup();
    const snaps = await fetchSnapshots(client, ['ZTSTA', 'ZTSTB', 'NOPE']);
    expect([...snaps.found.keys()].sort()).toEqual(['ZTSTA', 'ZTSTB']);
    const history = await fetchDailyHistory(client, ['ZTSTA', 'ZTSTB'], '2026-09-01');
    expect(history.found.get('ZTSTA')!.length).toBeGreaterThan(20);
    expect(
      history.found.get('ZTSTA')!.every((d, i, all) => i === 0 || all[i - 1]!.date < d.date),
    ).toBe(true);
    expect(fake.requests.filter((r) => r.url.includes('/v2/stocks/'))).toHaveLength(2);
  });

  it('puts history and the snapshot together, today last', async () => {
    const { client } = setup();
    const snaps = await fetchSnapshots(client, ['ZTSTA']);
    const history = await fetchDailyHistory(client, ['ZTSTA'], '2026-09-01');
    const src = screenSource(asset('ZTSTA'), history.found.get('ZTSTA')!, snaps.found.get('ZTSTA'));
    expect(src.days.at(-1)!.date).toBe('2026-10-06');
    expect(src.days.at(-2)!.date).toBe('2026-10-05');
    expect(src.last).toBeGreaterThan(0);
    expect(new Set(src.days.map((d) => d.date)).size).toBe(src.days.length);
  });

  it('waits and retries when Alpaca throttles', async () => {
    const { fake, client } = setup();
    fake.failNext(429, 2);
    const waits: number[] = [];
    const snaps = await fetchSnapshots(client, ['ZTSTA'], {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(snaps.found.has('ZTSTA')).toBe(true);
    expect(snaps.missed).toBe(0);
    expect(waits).toEqual([1000, 2000]);
    fake.failNext(503, 10);
    await expect(fetchSnapshots(client, ['ZTSTA'], { sleep: async () => {} })).rejects.toThrow(
      AlpacaUnavailableError,
    );
  });

  it('keeps the batches that answered when one keeps failing', async () => {
    const { fake } = setup();
    // 201 symbols make two batches; the first request fails every retry.
    const symbols = ['ZTSTA', ...Array.from({ length: 199 }, (_, i) => `ZZ${i}`), 'ZTSTB'];
    let calls = 0;
    const flaky = new AlpacaClient({
      credentials: fake.credentials,
      fetch: (url, init) => {
        const first = new URL(url).searchParams.get('symbols')?.startsWith('ZTSTA,');
        calls++;
        return first ? Promise.reject(new Error('socket hang up')) : fake.fetch(url, init);
      },
      tradingUrl: FAKE_ALPACA_TRADING_URL,
      dataUrl: FAKE_ALPACA_DATA_URL,
      allowLocal: true,
    });
    const snaps = await fetchSnapshots(flaky, symbols, { sleep: async () => {} });
    expect(snaps.missed).toBe(200);
    expect([...snaps.found.keys()]).toEqual(['ZTSTB']);
    expect(calls).toBe(5);
    // When nothing answers, the fetch fails.
    await expect(
      fetchSnapshots(flaky, ['ZTSTA', 'ZTSTB'], { sleep: async () => {} }),
    ).rejects.toThrow(AlpacaUnavailableError);
  });

  it('splits symbols into batches', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
