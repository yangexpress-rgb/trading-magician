import { UnsupportedBarRequestError } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { cboeProvider } from './cboe';
import { fakeCboeFetch, fakeVixHistory } from './cboe-fake';
import type { Fetch } from './cboe';

const now = () => new Date('2026-11-06T22:00:00Z');
const request = (patch: Record<string, unknown> = {}) => ({
  instrumentId: 'vix',
  symbol: 'VIX',
  assetClass: 'index',
  interval: '1d' as const,
  from: '2024-01-01',
  to: '2026-11-06',
  adjustment: 'split_and_dividend' as const,
  session: 'regular' as const,
  ...patch,
});

describe('CBOE index history feed (v1.2 item 5)', () => {
  it('gives multi-year daily VIX bars on NYSE sessions, Good Friday left out', async () => {
    let calls = 0;
    const fake = fakeCboeFetch(now);
    const provider = cboeProvider({
      fetch: (url, init) => {
        calls++;
        return fake(url, init);
      },
    });
    const history = provider.history({ now });
    const series = await history.getBars(request());
    expect(series.bars.length).toBeGreaterThan(650);
    expect(series.bars.at(-1)?.end).toBe('2026-11-06T21:00:00.000Z');
    expect(series.warnings.join(' ')).toMatch(/published on days the NYSE was closed/);
    expect(series.dataVersion).toMatch(/^cboe-[0-9a-f]{16}$/);
    // One download serves every later request.
    await history.getBars(request({ from: '1990-01-01' }));
    expect(calls).toBe(1);
  }, 30_000);

  it('refuses intraday bars and indices it does not know', async () => {
    const history = cboeProvider({ fetch: fakeCboeFetch(now) }).history({ now });
    await expect(history.getBars(request({ interval: '5m' }))).rejects.toBeInstanceOf(
      UnsupportedBarRequestError,
    );
    await expect(history.getBars(request({ symbol: 'VIXY' }))).rejects.toBeInstanceOf(
      UnsupportedBarRequestError,
    );
  });

  it('has no live prices, and its check says whether CBOE answers', async () => {
    const ok = cboeProvider({ fetch: fakeCboeFetch(now) });
    expect(await ok.quotes({ now }).latestQuote({ instrumentId: 'vix', symbol: 'VIX' })).toBe(
      undefined,
    );
    expect(await ok.check({ now })).toMatchObject({ ok: true, entitlement: 'entitled' });
    const down = cboeProvider({ fetch: async () => new Response('no', { status: 503 }) });
    expect(await down.check({ now })).toMatchObject({ ok: false });
  });

  it('writes the fake history the way CBOE does, from 1990', () => {
    const lines = fakeVixHistory('2026-11-06').split('\n');
    expect(lines[0]).toBe('DATE,OPEN,HIGH,LOW,CLOSE');
    expect(lines[1]).toMatch(/^01\/02\/1990,/);
  });

  it("falls back to FRED's VIXCLS when CBOE is down, with flat bars and a warning", async () => {
    const fake = fakeCboeFetch(now);
    const urls: string[] = [];
    const cboeDown: Fetch = (url, init) => {
      urls.push(url);
      return url.includes('cboe.com')
        ? Promise.resolve(new Response('no', { status: 503 }))
        : fake(url, init);
    };
    const series = await cboeProvider({ fetch: cboeDown }).history({ now }).getBars(request());
    expect(urls).toEqual([
      'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv',
      'https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS',
    ]);
    expect(series.bars.length).toBeGreaterThan(650);
    const last = series.bars.at(-1)!;
    expect([last.open, last.high, last.low].map(String)).toEqual(Array(3).fill(String(last.close)));
    expect(series.dataVersion).toMatch(/^fred-/);
    expect(series.warnings.join(' ')).toMatch(/comes from FRED \(VIXCLS\): closes only/);
  }, 30_000);

  it('reads both URLs from configuration', async () => {
    const urls: string[] = [];
    const down: Fetch = async (url) => {
      urls.push(url);
      return new Response('no', { status: 500 });
    };
    const provider = cboeProvider({
      fetch: down,
      historyUrl: 'https://mirror.example/cboe/',
      fredUrl: 'https://mirror.example/fred.csv',
    });
    await expect(provider.history({ now }).getBars(request())).rejects.toThrow(
      /CBOE answered 500 for VIX, and its FRED copy \(VIXCLS\) could not be loaded either/,
    );
    expect(urls).toEqual([
      'https://mirror.example/cboe/VIX_History.csv',
      'https://mirror.example/fred.csv?id=VIXCLS',
    ]);
  });

  it('says how many impossible rows it left out, and credits Cboe', async () => {
    const good = fakeVixHistory('2026-11-06');
    const bad = good.replace(
      /\n(\d\d\/\d\d\/2025),([\d.]+),([\d.]+),([\d.]+),([\d.]+)\n/,
      '\n$1,$2,1.00,$4,$5\n',
    );
    expect(bad).not.toBe(good);
    const fetch: Fetch = async () => new Response(bad, { status: 200 });
    const series = await cboeProvider({ fetch }).history({ now }).getBars(request());
    expect(series.warnings.join(' ')).toMatch(
      /1 row of the VIX file was left out as malformed or impossible/,
    );
    expect(series.warnings[0]).toMatch(/Source: Cboe Global Markets/);
  }, 30_000);
});
