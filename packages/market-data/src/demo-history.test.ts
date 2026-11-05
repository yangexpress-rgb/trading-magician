import { isTradingDay, nyDate, type BarRequest } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { createDemoHistoryProvider, DEMO_HISTORY_VERSION } from './demo-history';

const NOW = new Date('2026-10-02T21:00:00Z');
const provider = createDemoHistoryProvider({ now: () => NOW });

const req = (patch: Partial<BarRequest> = {}): BarRequest => ({
  instrumentId: 'a',
  symbol: 'DEMO-A',
  assetClass: 'stock',
  interval: '1d',
  from: '2024-01-01',
  to: '2024-12-31',
  adjustment: 'split_and_dividend',
  session: 'regular',
  ...patch,
});

describe('demo history provider', () => {
  it('returns one well-formed daily bar per NYSE trading day', async () => {
    const { bars, dataVersion, warnings } = await provider.getBars(req({ adjustment: 'none' }));
    expect(bars).toHaveLength(252);
    expect(dataVersion).toBe(DEMO_HISTORY_VERSION);
    expect(warnings).toEqual([]);
    for (const b of bars) {
      expect(isTradingDay(nyDate(b.start))).toBe(true);
      expect(b.high.gte(b.open) && b.high.gte(b.close) && b.low.lte(b.open)).toBe(true);
      expect(b.low.gt(0) && b.volume.gt(0)).toBe(true);
      expect(Date.parse(b.end)).toBeGreaterThan(Date.parse(b.start));
    }
    // The first call generates the paths from 2015 on, which takes a few seconds on a busy runner.
  }, 20_000);

  it('is deterministic and independent of the requested range', async () => {
    const year = await provider.getBars(req());
    const again = await createDemoHistoryProvider({ now: () => NOW }).getBars(req());
    const q3 = await provider.getBars(req({ from: '2024-07-01', to: '2024-09-30' }));
    expect(again.bars).toEqual(year.bars);
    const first = q3.bars[0]!;
    expect(year.bars.find((b) => b.start === first.start)).toEqual(first);
  });

  it('builds daily bars from the hourly ones, with a few hourly bars missing', async () => {
    const day = req({ from: '2024-03-05', to: '2024-03-05', adjustment: 'none' });
    const [daily] = (await provider.getBars(day)).bars;
    const hourly = (await provider.getBars({ ...day, interval: '1h' })).bars;
    expect(hourly.map((b) => b.start)).toContain('2024-03-05T14:30:00.000Z');
    expect(daily!.open).toEqual(hourly[0]!.open);
    expect(daily!.close).toEqual(hourly.at(-1)!.close);

    const year = (await provider.getBars(req({ interval: '1h', adjustment: 'none' }))).bars;
    // 249 full days of 7 bars plus 3 early closes of 4, less the missing ones.
    const expected = 249 * 7 + 3 * 4;
    expect(year.length).toBeLessThan(expected);
    expect(year.length).toBeGreaterThan(expected * 0.99);
  });

  it('moves sector pairs together', async () => {
    const closes = async (symbol: string) =>
      (await provider.getBars(req({ symbol, from: '2020-01-01', to: '2024-12-31' }))).bars.map(
        (b) => b.close.toNumber(),
      );
    const returns = (xs: number[]) => xs.slice(1).map((x, i) => Math.log(x / xs[i]!));
    const corr = (a: number[], b: number[]) => {
      const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
      const [ma, mb] = [mean(a), mean(b)];
      const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i]! - mb), 0);
      const va = a.reduce((s, x) => s + (x - ma) ** 2, 0);
      const vb = b.reduce((s, x) => s + (x - mb) ** 2, 0);
      return cov / Math.sqrt(va * vb);
    };
    const a = returns(await closes('DEMO-A'));
    const b = returns(await closes('DEMO-B'));
    const e = returns(await closes('DEMO-E'));
    expect(corr(a, b)).toBeGreaterThan(0.7);
    expect(corr(a, e)).toBeLessThan(0.5);
  });

  it('applies the DEMO-C split and DEMO-E dividends only to adjusted prices', async () => {
    const around = { symbol: 'DEMO-C', from: '2021-06-11', to: '2021-06-14' };
    const raw = (await provider.getBars(req({ ...around, adjustment: 'none' }))).bars;
    const adj = (await provider.getBars(req({ ...around, adjustment: 'split_only' }))).bars;
    const rawJump = raw[1]!.open.div(raw[0]!.close).toNumber();
    const adjJump = adj[1]!.open.div(adj[0]!.close).toNumber();
    expect(rawJump).toBeLessThan(0.6);
    expect(adjJump).toBeGreaterThan(0.85);
    expect(adj[0]!.volume.toNumber()).toBe(raw[0]!.volume.toNumber() * 2);

    const e = { symbol: 'DEMO-E', from: '2024-01-02', to: '2024-01-31' };
    const eRaw = (await provider.getBars(req({ ...e, adjustment: 'split_only' }))).bars;
    const eAdj = (await provider.getBars(req({ ...e, adjustment: 'split_and_dividend' }))).bars;
    expect(eAdj[0]!.close.lt(eRaw[0]!.close)).toBe(true);
  });

  it('never returns bars that end after now, and explains substitutions', async () => {
    const live = await provider.getBars(
      req({ from: '2026-09-28', to: '2026-12-31', interval: '1h', session: 'extended' }),
    );
    expect(Date.parse(live.bars.at(-1)!.end)).toBeLessThanOrEqual(NOW.getTime());
    expect(live.warnings).toEqual(['Demo history has regular-session bars only']);
    const early = await provider.getBars(req({ from: '2010-01-01', to: '2015-01-09' }));
    expect(early.warnings).toEqual(['Demo history starts on 2015-01-02']);
    await expect(provider.getBars(req({ interval: '15m' }))).rejects.toThrow(/not 15m/);
    await expect(provider.getBars(req({ symbol: 'NOPE' }))).rejects.toThrow(/No demo history/);
  });
});

describe('five-minute demo bars', () => {
  it('add up to the hourly bars they come from, and never change', async () => {
    const day = { from: '2024-03-05', to: '2024-03-05' };
    const hourly = await provider.getBars(req({ ...day, interval: '1h' }));
    const fives = await provider.getBars(req({ ...day, interval: '5m' }));
    // 6.5 hours of trading, less any hour left out as missing.
    expect(fives.bars.length).toBe(
      hourly.bars.reduce((n, h) => n + (Date.parse(h.end) - Date.parse(h.start)) / 300_000, 0),
    );
    for (const h of hourly.bars) {
      const inside = fives.bars.filter((b) => b.start >= h.start && b.end <= h.end);
      expect(inside[0]!.open.toString()).toBe(h.open.toString());
      expect(inside.at(-1)!.close.toString()).toBe(h.close.toString());
      expect(Math.max(...inside.map((b) => b.high.toNumber()))).toBe(h.high.toNumber());
      expect(Math.min(...inside.map((b) => b.low.toNumber()))).toBe(h.low.toNumber());
      expect(inside.reduce((v, b) => v + b.volume.toNumber(), 0)).toBe(h.volume.toNumber());
      for (const b of inside) {
        expect(b.high.gte(b.open) && b.high.gte(b.close)).toBe(true);
        expect(b.low.lte(b.open) && b.low.lte(b.close)).toBe(true);
      }
    }
    const again = await createDemoHistoryProvider({ now: () => NOW }).getBars(
      req({ ...day, interval: '5m' }),
    );
    expect(again.bars).toEqual(fives.bars);
  });
});
