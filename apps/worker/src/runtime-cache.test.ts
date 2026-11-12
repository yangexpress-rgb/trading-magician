import type { SeriesPlan } from '@tm/backtest';
import type { Bar, BarRequest, BarSeries, HistoricalDataProvider } from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  FAILED_RETRY_MS,
  lastBarEnd,
  MISSING_RETRY_MS,
  nextBarEnd,
  nextCheckAt,
  RuntimeBarCache,
  RuntimeUniverses,
} from './runtime-cache';

const at = (iso: string) => Date.parse(iso);

describe('when bars end (ADR 0087)', () => {
  it('finds the next 5-minute, hourly and daily bar end in the session', () => {
    // Thursday 2026-11-12, 10:02 New York.
    const t = at('2026-11-12T15:02:00Z');
    expect(new Date(nextBarEnd('5m', t)).toISOString()).toBe('2026-11-12T15:05:00.000Z');
    expect(new Date(nextBarEnd('1h', t)).toISOString()).toBe('2026-11-12T16:00:00.000Z');
    expect(new Date(nextBarEnd('1d', t)).toISOString()).toBe('2026-11-12T21:00:00.000Z');
    // Before the open, the first bar ends 5 minutes after it.
    expect(new Date(nextBarEnd('5m', at('2026-11-12T12:00:00Z'))).toISOString()).toBe(
      '2026-11-12T14:35:00.000Z',
    );
    // Friday evening: Monday's first bar.
    expect(new Date(nextBarEnd('5m', at('2026-11-13T22:00:00Z'))).toISOString()).toBe(
      '2026-11-16T14:35:00.000Z',
    );
  });

  it('finds the latest bar that has ended', () => {
    expect(new Date(lastBarEnd('5m', at('2026-11-12T15:02:00Z'))!).toISOString()).toBe(
      '2026-11-12T15:00:00.000Z',
    );
    // Daily: before today's close, yesterday's close.
    expect(new Date(lastBarEnd('1d', at('2026-11-12T15:02:00Z'))!).toISOString()).toBe(
      '2026-11-11T21:00:00.000Z',
    );
    // Five minutes into the session: the open's first bar isn't in, so yesterday's close.
    expect(new Date(lastBarEnd('5m', at('2026-11-12T14:33:00Z'))!).toISOString()).toBe(
      '2026-11-11T21:00:00.000Z',
    );
  });

  it('asks again shortly while an expected bar is missing, then waits for the next', () => {
    const t = at('2026-11-12T15:05:20Z');
    expect(nextCheckAt('5m', t, at('2026-11-12T15:00:00Z'))).toBe(t + MISSING_RETRY_MS);
    expect(nextCheckAt('5m', t, at('2026-11-12T15:05:00Z'))).toBe(at('2026-11-12T15:10:20Z'));
    // Long past the bar: no more retries for a stock without trades in it.
    const later = at('2026-11-12T15:09:00Z');
    expect(nextCheckAt('5m', later, at('2026-11-12T15:00:00Z'))).toBe(at('2026-11-12T15:10:20Z'));
  });
});

const bar = (endIso: string, minutes: number): Bar => {
  const end = Date.parse(endIso);
  return {
    start: new Date(end - minutes * 60_000).toISOString(),
    end: new Date(end).toISOString(),
    open: new Decimal(1),
    high: new Decimal(1),
    low: new Decimal(1),
    close: new Decimal(1),
    volume: new Decimal(1),
  };
};

/** Daily bars ending at 16:00 New York on each date asked for, up to the clock. */
function fakeHistory(clock: { t: number }, opts: { batch?: boolean; fail?: Set<string> } = {}) {
  const calls: BarRequest[][] = [];
  const one = async (r: BarRequest): Promise<BarSeries> => {
    if (opts.fail?.has(r.symbol)) throw new Error(`no bars for ${r.symbol}`);
    const bars: Bar[] = [];
    for (
      let d = Date.parse(`${r.from}T00:00:00Z`);
      d <= Date.parse(`${r.to}T00:00:00Z`);
      d += 86_400_000
    ) {
      const date = new Date(d).toISOString().slice(0, 10);
      const day = new Date(d).getUTCDay();
      if (day === 0 || day === 6) continue;
      const b = bar(`${date}T21:00:00Z`, 390);
      if (Date.parse(b.end) <= clock.t) bars.push(b);
    }
    return { bars, dataVersion: 'v', warnings: [] };
  };
  const history: HistoricalDataProvider = {
    id: 'fake',
    intervals: ['1d'],
    getBars: async (r) => {
      calls.push([r]);
      return one(r);
    },
    ...(opts.batch
      ? {
          getBarsMany: async (rs: readonly BarRequest[]) => {
            calls.push([...rs]);
            return Promise.all(rs.map((r) => one(r).catch((e: Error) => e)));
          },
        }
      : {}),
  };
  return { history, calls };
}

const plan = (id: string, from: string, to: string, bars = 20): SeriesPlan => ({
  spec: { instrumentId: id, interval: '1d', adjustment: 'split_and_dividend', session: 'regular' },
  from,
  to,
  bars,
});
const refs = new Map(
  ['a', 'b', 'c'].map((id) => [
    id,
    { symbol: id.toUpperCase(), assetClass: 'stock', lotSize: '1' },
  ]),
);

describe('paper bars kept between passes (ADR 0087)', () => {
  it('loads every member in one batch, then asks nothing until the next close', async () => {
    const clock = { t: at('2026-11-12T15:00:00Z') };
    const { history, calls } = fakeHistory(clock, { batch: true });
    const cache = new RuntimeBarCache();
    const plans = ['a', 'b', 'c'].map((id) => plan(id, '2026-11-02', '2026-11-12'));
    const load = () =>
      cache.load({
        scope: 'u',
        owner: 'r1',
        history,
        plans,
        instruments: refs,
        now: new Date(clock.t),
      });
    const first = await load();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(first.series.get('a|1d|split_and_dividend|regular')?.at(-1)?.end).toBe(
      '2026-11-11T21:00:00.000Z',
    );
    for (let i = 0; i < 10; i++) {
      clock.t += 60_000;
      await load();
    }
    expect(calls).toHaveLength(1);
    // Passes go on all day; after the close and its grace, one request brings
    // Thursday's bar for all three.
    while (clock.t < at('2026-11-12T21:06:00Z')) {
      clock.t += 10 * 60_000;
      if (clock.t < at('2026-11-12T21:05:00Z')) await load();
    }
    expect(calls).toHaveLength(1);
    const next = await load();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.map((r) => r.from)).toEqual(['2026-11-11', '2026-11-11', '2026-11-11']);
    const a = next.series.get('a|1d|split_and_dividend|regular')!;
    expect(a.at(-1)?.end).toBe('2026-11-12T21:00:00.000Z');
    expect(new Set(a.map((b) => b.end)).size).toBe(a.length);
    expect(a).toHaveLength(9);
  });

  it('shares series between runtimes on the same feeds, and keeps the earliest date any needs', async () => {
    const clock = { t: at('2026-11-12T15:00:00Z') };
    const { history, calls } = fakeHistory(clock, { batch: true });
    const cache = new RuntimeBarCache();
    const now = new Date(clock.t);
    await cache.load({
      scope: 'u',
      owner: 'r1',
      history,
      plans: [plan('a', '2026-11-09', '2026-11-12')],
      instruments: refs,
      now,
    });
    const wider = await cache.load({
      scope: 'u',
      owner: 'r2',
      history,
      plans: [plan('a', '2026-11-02', '2026-11-12')],
      instruments: refs,
      now,
    });
    expect(calls).toHaveLength(2); // the wider window needs an earlier start
    expect(wider.series.get('a|1d|split_and_dividend|regular')).toHaveLength(8);
    const narrow = await cache.load({
      scope: 'u',
      owner: 'r1',
      history,
      plans: [plan('a', '2026-11-09', '2026-11-12')],
      instruments: refs,
      now,
    });
    expect(calls).toHaveLength(2);
    // r2 still reads it, so nothing r2 needs is let go.
    expect(narrow.series.get('a|1d|split_and_dividend|regular')).toHaveLength(8);
    // Another person's feeds: loaded separately.
    await cache.load({
      scope: 'v',
      owner: 'r3',
      history,
      plans: [plan('a', '2026-11-09', '2026-11-12')],
      instruments: refs,
      now,
    });
    expect(calls).toHaveLength(3);
  });

  it('leaves out a member whose bars fail, and asks again only after a minute', async () => {
    const clock = { t: at('2026-11-12T15:00:00Z') };
    const fail = new Set(['B']);
    const { history, calls } = fakeHistory(clock, { fail });
    const cache = new RuntimeBarCache();
    const plans = ['a', 'b'].map((id) => plan(id, '2026-11-09', '2026-11-12'));
    const load = (optional: Set<string>) =>
      cache.load({
        scope: 'u',
        owner: 'r1',
        history,
        plans,
        instruments: refs,
        now: new Date(clock.t),
        optional,
      });
    const first = await load(new Set(['a', 'b']));
    expect(first.series.has('b|1d|split_and_dividend|regular')).toBe(false);
    expect(first.warnings[0]).toMatch(/1 member was left out.*B/);
    expect(calls).toHaveLength(2); // one at a time without a batch method
    clock.t += 1_000;
    await load(new Set(['a', 'b']));
    expect(calls).toHaveLength(2);
    // Not a member: the pass stops, naming it.
    await expect(load(new Set(['a']))).rejects.toThrow(/Bars for B could not be loaded/);
    fail.clear();
    clock.t += FAILED_RETRY_MS;
    const later = await load(new Set(['a', 'b']));
    expect(later.series.has('b|1d|split_and_dividend|regular')).toBe(true);
  });
});

describe('built-in group members for paper runs', () => {
  it('looks a group up once a day and keeps the last list when a lookup fails', async () => {
    let calls = 0;
    let broken = false;
    const universes = new RuntimeUniverses(async () => {
      calls++;
      if (broken) throw new Error('feed down');
      return { ids: ['a', 'b', 'gone'], warnings: [] };
    });
    const refsOf = async (ids: string[]) =>
      new Map(
        ids
          .filter((id) => id !== 'gone')
          .map((id) => [id, { symbol: id, assetClass: 'stock', lotSize: '1' }]),
      );
    const day1 = new Date('2026-11-12T15:00:00Z');
    expect((await universes.members('u', 'sp500', day1, refsOf)).ids).toEqual(['a', 'b']);
    await universes.members('u', 'sp500', new Date(day1.getTime() + 3_600_000), refsOf);
    expect(calls).toBe(1);
    broken = true;
    const day2 = new Date('2026-11-13T15:00:00Z');
    expect((await universes.members('u', 'sp500', day2, refsOf)).ids).toEqual(['a', 'b']);
    expect(calls).toBe(2);
    await universes.members('u', 'sp500', new Date(day2.getTime() + 60_000), refsOf);
    expect(calls).toBe(2); // retried after five minutes, not every pass
    await expect(new RuntimeUniverses().members('u', 'sp500', day1, refsOf)).rejects.toThrow(
      /cannot resolve/,
    );
  });
});

describe('how many bars a paper series keeps (ADR 0087)', () => {
  it('keeps twice what the rules read back, at least two sessions more, not the load margin', async () => {
    const clock = { t: at('2026-11-12T15:00:00Z') };
    const { history } = fakeHistory(clock, { batch: true });
    const cache = new RuntimeBarCache();
    // Rules that read the latest 2 daily bars keep 4; the plan loaded 9.
    const loaded = await cache.load({
      scope: 'u',
      owner: 'r1',
      history,
      plans: [plan('a', '2026-11-02', '2026-11-12', 2)],
      instruments: refs,
      now: new Date(clock.t),
    });
    expect(loaded.series.get('a|1d|split_and_dividend|regular')).toHaveLength(4);
    expect(cache.bars).toBe(4);
  });
});
