import { UnsupportedBarRequestError } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { cboeProvider } from './cboe';
import { fakeCboeFetch, fakeVixHistory } from './cboe-fake';

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
  });

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
});
