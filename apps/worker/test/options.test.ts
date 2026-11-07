import type { OptionBar, OptionContractRef } from '@tm/alpaca';
import {
  addSeedUnderlyings,
  createFeed,
  listOptionUniverse,
  loadOptionSignals,
  provisionWorkspace,
  registerInstrument,
  saveOptionSignal,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  addDays,
  bsmPrice,
  nyDate,
  OPTION_SIGNAL_FIELDS,
  regularSession,
  signalAt,
  tradingDays,
  type Bar,
  type CboeChain,
  type OptionSignalValues,
  type PriceAdjustment,
} from '@tm/domain';
import { F2_AS_OF, F2_PRIOR_IV30, F2_ROWS, F2_S } from '@tm/domain/options-fixtures';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChainSource } from '../src/options/cboe-options';
import { optionsFeedProvider } from '../src/options/feed';
import type { MarketInputs } from '../src/options/market-inputs';
import { rebuildUnderlying, type RebuildSource } from '../src/options/rebuild';
import {
  fetchDue,
  recordingDay,
  recordUnderlying,
  runRetention,
  type OptionsJobOptions,
} from '../src/options/recording';

/**
 * Options data Phase 1 (options data brief v2 §5, ADR 0047): ingest (F1),
 * retention (F3), the stale-file guard (F6) and the history rebuild (F7),
 * against a real database with the worker's login.
 */

let t: TestDatabase;
let spy: string;
let user: string;
const quiet = { info: () => undefined, warn: () => undefined };

const nullValues = () =>
  Object.fromEntries(OPTION_SIGNAL_FIELDS.map((f) => [f, null])) as OptionSignalValues;

/** Daily bars of the underlying: `close(date)` for each NYSE day. */
function inputsFrom(close: (date: string) => number | undefined, rate = 0.05): MarketInputs {
  return {
    hasCloses: true,
    async dailyBars(_u, from, to, _adj: PriceAdjustment) {
      const bars: Bar[] = [];
      for (const d of tradingDays(from, to)) {
        const c = close(d);
        if (c === undefined) continue;
        const s = regularSession(d) ?? { open: `${d}T14:30:00Z`, close: `${d}T21:00:00Z` };
        const v = new Decimal(c);
        bars.push({ start: s.open, end: s.close, open: v, high: v, low: v, close: v, volume: v });
      }
      // The F1 day is a Saturday (see the fixture): give it a bar of its own.
      if (from <= F2_AS_OF && to >= F2_AS_OF && close(F2_AS_OF) !== undefined) {
        const v = new Decimal(close(F2_AS_OF) as number);
        bars.push({
          start: `${F2_AS_OF}T14:30:00Z`,
          end: `${F2_AS_OF}T21:00:00Z`,
          open: v,
          high: v,
          low: v,
          close: v,
          volume: v,
        });
      }
      return bars.sort((a, b) => a.start.localeCompare(b.start));
    },
    riskFreeRate: async () => rate,
  };
}

/** The F2 chain as CBOE's parsed file, stamped at `stamp`. */
function f2Chain(stamp: string): CboeChain {
  return {
    fileTimestamp: stamp,
    skipped: 1,
    rows: F2_ROWS.map((r) => ({
      occSymbol: `SPY${r.expiry.slice(2).replace(/-/g, '')}${r.right === 'call' ? 'C' : 'P'}${String(r.strike * 1000).padStart(8, '0')}`,
      expiry: r.expiry,
      strike: r.strike,
      right: r.right,
      bid: r.bid,
      bidSize: 0,
      ask: r.ask,
      askSize: 0,
      last: null,
      volume: r.volume,
      openInterest: r.openInterest,
      iv: r.iv,
      delta: r.delta,
      gamma: r.gamma,
      vega: null,
      theta: null,
      rho: null,
      theo: null,
    })),
  };
}

const source = (chain: () => CboeChain): ChainSource => ({
  feed: 'cboe',
  chain: async () => ({ chain: chain(), dataVersion: 'cboe-test' }),
});

/** Stands in for the pricing package with the fixture's computed IV, delta and gamma. */
const fixtureGreeks: NonNullable<OptionsJobOptions['greeks']> = (_market, contracts) =>
  contracts.map((c) => {
    const row = F2_ROWS.find(
      (r) => r.expiry === c.expiry && r.strike === c.strike && r.right === c.right,
    );
    return {
      iv: row?.iv ?? undefined,
      delta: row?.delta ?? undefined,
      gamma: row?.gamma ?? undefined,
    };
  });

/** 21 closes whose 20 daily returns alternate ±x with an annualised sample deviation of 0.16. */
function closesWithVol16(end: string): Map<string, number> {
  const x = 0.16 / Math.sqrt(252) / Math.sqrt(20 / 19);
  const days = tradingDays(addDays(end, -40), addDays(end, -1)).slice(-20);
  const out = new Map<string, number>();
  let c = F2_S;
  // Walk back from the day's close so it is exactly 600.
  const all = [...days, end];
  const values: number[] = [c];
  for (let i = all.length - 2; i >= 0; i--) {
    const r = (all.length - 2 - i) % 2 === 0 ? x : -x;
    c = c / (1 + r);
    values.unshift(c);
  }
  all.forEach((d, i) => out.set(d, values[i] as number));
  return out;
}

beforeAll(async () => {
  t = await createTestDatabase();
  spy = await t.worker.db.transaction((tx) =>
    registerInstrument(tx, {
      assetClass: 'etf',
      symbol: 'SPY',
      venue: 'ARCA',
      displayName: 'SPDR S&P 500 ETF Trust',
      provider: 'alpaca',
      providerId: 'spy-test',
    }),
  );
  await addSeedUnderlyings(t.worker.db, [spy]);
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Options', email: 'options@example.test' })
    .returning({ id: schema.users.id });
  user = row!.id;
  await provisionWorkspace(t.app.db, { userId: user, displayName: 'Options' });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

const universeRow = async () =>
  (await listOptionUniverse(t.worker.db)).find((u) => u.symbol === 'SPY')!;
const count = async (table: string) =>
  Number((await t.ownerSql.unsafe(`select count(*)::int as n from ${table}`))[0]?.n ?? 0);

describe('the recording schedule', () => {
  it('records after 16:45 New York until the next open', () => {
    expect(recordingDay(new Date('2026-11-06T21:44:00Z'))).toBeUndefined(); // 16:44 Fri: not yet
    expect(recordingDay(new Date('2026-11-06T21:45:00Z'))).toBe('2026-11-06');
    expect(recordingDay(new Date('2026-11-08T15:00:00Z'))).toBe('2026-11-06'); // Sunday
    expect(recordingDay(new Date('2026-11-09T14:30:00Z'))).toBeUndefined(); // Monday's open
  });

  it('allows one retry, 30 minutes after a failed fetch', async () => {
    const u = await universeRow();
    const at = (iso: string) => new Date(iso);
    expect(fetchDue(u, '2026-11-06', at('2026-11-06T21:45:00Z'))).toBe(true);
    const failed = {
      ...u,
      attemptDate: '2026-11-06',
      attemptCount: 1,
      lastAttemptAt: at('2026-11-06T21:45:00Z'),
    };
    expect(fetchDue(failed, '2026-11-06', at('2026-11-06T22:10:00Z'))).toBe(false);
    expect(fetchDue(failed, '2026-11-06', at('2026-11-06T22:15:00Z'))).toBe(true);
    expect(fetchDue({ ...failed, attemptCount: 2 }, '2026-11-06', at('2026-11-07T01:00:00Z'))).toBe(
      false,
    );
  });
});

describe('ingest (F1)', () => {
  const vol = closesWithVol16(F2_AS_OF);
  const options = (): OptionsJobOptions => ({
    db: t.worker.db,
    chains: source(() => f2Chain('2026-11-28T15:00:00Z')),
    inputs: inputsFrom((d) => vol.get(d) ?? (d === F2_AS_OF ? F2_S : undefined)),
    logger: quiet,
    now: () => new Date('2026-11-28T22:00:00Z'),
    greeks: fixtureGreeks,
    ivRankMinHistory: 5,
  });

  it('stores contracts, the day’s chain, one signal row and two expiry rows', async () => {
    // Five prior days of IV30 for the rank fixture.
    for (const [i, iv30] of F2_PRIOR_IV30.entries()) {
      await saveOptionSignal(t.worker.db, {
        underlyingId: spy,
        asOfDate: addDays('2026-11-20', i),
        values: { ...nullValues(), iv30 },
        ivHistoryDays: 0,
        expiries: [],
        underlyingClose: 600,
        riskFreeRate: 0.05,
        dividendYield: 0,
        source: 'recorded',
        feed: 'cboe',
        computedAt: new Date(),
      });
    }
    expect(await recordUnderlying(options(), await universeRow(), F2_AS_OF)).toBe('stored');
    expect(await count('option_contract')).toBe(12);
    expect(await count(`option_chain_snapshot where as_of_date = '${F2_AS_OF}'`)).toBe(12);
    expect(await count(`option_expiry_signal where as_of_date = '${F2_AS_OF}'`)).toBe(2);
    const signals = (await loadOptionSignals(t.worker.db, [spy])).get(spy)!;
    const day = signals.find((s) => s.asOfDate === F2_AS_OF)!;
    expect(day.source).toBe('recorded');
    const v = day.values;
    const near = (a: number | null, e: number, tol: number) =>
      expect(Math.abs((a as number) - e)).toBeLessThanOrEqual(tol);
    near(v.iv30, 0.1972, 0.001);
    near(v.atm_iv, 0.185, 0.001);
    near(v.expected_move_5d_usd, 13.85, 0.05);
    near(v.expected_move_1d_usd, 6.19, 0.05);
    near(v.straddle_move_pct, 0.0262, 0.001);
    near(v.skew_30d, 0.04, 0.001);
    near(v.term_structure, 0.938, 0.001);
    near(v.iv_rank_252d, 74.5, 0.1);
    near(v.iv_percentile_252d, 80, 0.001);
    near(v.iv_rv_ratio, 1.23, 0.01);
    near(v.put_call_volume, 0.9444, 0.001);
    near(v.put_call_oi, 1, 0.001);
    expect(Math.round(v.net_gex as number)).toBe(-2_160_000);
    expect([v.call_wall, v.put_wall, v.max_pain]).toEqual([610, 590, 600]);
    const u = await universeRow();
    expect(u).toMatchObject({
      lastSnapshotDate: F2_AS_OF,
      lastSignalDate: F2_AS_OF,
      lastSkipped: 1,
      lastError: null,
    });
  });

  it('keeps the source’s own IV beside the app’s computed IV', async () => {
    const [row] = await t.ownerSql`
      select s.iv::float as iv, s.iv_calc::float as iv_calc, s.underlying_close::float as close
        from option_chain_snapshot s join option_contract c on c.id = s.contract_id
       where c.strike = 610 and c.right = 'call' and c.expiry = '2026-12-18'`;
    expect(row).toEqual({ iv: 0.16, iv_calc: 0.16, close: 600 });
  });

  it('replaces the day when it is ingested again, never duplicating it', async () => {
    expect(await recordUnderlying(options(), await universeRow(), F2_AS_OF)).toBe('stored');
    expect(await count('option_contract')).toBe(12);
    expect(await count(`option_chain_snapshot where as_of_date = '${F2_AS_OF}'`)).toBe(12);
    expect(await count(`option_daily_signal where as_of_date = '${F2_AS_OF}'`)).toBe(1);
    expect(await count(`option_expiry_signal where as_of_date = '${F2_AS_OF}'`)).toBe(2);
  });

  it('stores the chain but waits for the close before deriving a signal', async () => {
    const day = '2026-11-30';
    const waiting: OptionsJobOptions = {
      ...options(),
      chains: source(() => f2Chain('2026-11-30T21:30:00Z')),
      inputs: inputsFrom(() => undefined),
    };
    expect(await recordUnderlying(waiting, await universeRow(), day)).toBe('stored');
    expect(await count(`option_chain_snapshot where as_of_date = '${day}'`)).toBe(12);
    expect(await count(`option_daily_signal where as_of_date = '${day}'`)).toBe(0);
  });
});

describe('the stale-file guard (F6)', () => {
  it('refuses a file older than the previous session’s close and keeps the last good day', async () => {
    const day = '2026-12-01';
    const stale: OptionsJobOptions = {
      db: t.worker.db,
      // The previous session closed 2026-11-30 at 21:00Z; this file is from the morning.
      chains: source(() => f2Chain('2026-11-30T15:00:00Z')),
      inputs: inputsFrom(() => F2_S),
      logger: quiet,
      now: () => new Date('2026-12-01T21:50:00Z'),
    };
    const before = await universeRow();
    expect(await recordUnderlying(stale, before, day)).toBe('stale');
    expect(await count(`option_chain_snapshot where as_of_date = '${day}'`)).toBe(0);
    const after = await universeRow();
    expect(after.lastSnapshotDate).toBe(before.lastSnapshotDate);
    expect(after).toMatchObject({ attemptDate: day, attemptCount: 1 });
    expect(after.lastError).toMatch(/before the previous session's close/);
    const signals = (await loadOptionSignals(t.worker.db, [spy])).get(spy)!;
    expect(signals.at(-1)?.asOfDate).toBe(F2_AS_OF);
  });
});

describe('the feed check', () => {
  it('is healthy and delayed while snapshots arrive, down after 3 sessions without one', async () => {
    const check = (iso: string) =>
      withTenant(t.app.db, { userId: user }, (tx) =>
        optionsFeedProvider().check({
          now: () => new Date(iso),
          inTenant: (fn) => fn(tx as Transaction),
        }),
      );
    // The latest snapshot is 2026-11-30 (stored above, waiting for its close).
    expect(await check('2026-12-02T22:00:00Z')).toEqual({
      ok: true,
      entitlement: 'entitled',
      realtime: false,
    });
    expect(await check('2026-12-03T22:00:00Z')).toMatchObject({
      ok: false,
      error: 'No options snapshot has been stored since 2026-11-30',
    });
  });

  it('can be added as a feed with no key and no routes', async () => {
    const feed = await withTenant(t.app.db, { userId: user }, (tx) =>
      createFeed(tx, {
        userId: user,
        name: 'CBOE delayed options (daily)',
        provider: 'cboe_options',
        assetClasses: ['stock', 'etf'],
      }),
    );
    expect(feed.provider).toBe('cboe_options');
    const routes =
      await t.ownerSql`select count(*)::int as n from data_route where primary_feed_id = ${feed.id}`;
    expect(routes[0]?.n).toBe(0);
  });
});

describe('retention (F3)', () => {
  it('deletes snapshot, signal and expiry rows older than the window; contracts stay', async () => {
    const o: OptionsJobOptions = {
      db: t.worker.db,
      chains: source(() => f2Chain('2026-11-28T15:00:00Z')),
      inputs: inputsFrom(() => F2_S),
      logger: quiet,
      now: () => new Date('2026-11-30T23:00:00Z'),
      historyDays: 5,
    };
    const pruned = await runRetention(o);
    expect(pruned.signals).toBeGreaterThan(0); // the 2026-11-20 to 2026-11-24 rows
    expect(await count(`option_daily_signal where as_of_date < '2026-11-25'`)).toBe(0);
    expect(await count(`option_chain_snapshot where as_of_date < '2026-11-25'`)).toBe(0);
    expect(await count(`option_expiry_signal where as_of_date < '2026-11-25'`)).toBe(0);
    expect(await count('option_contract')).toBe(12);
    // A condition on a deleted day reads unknown.
    const list = (await loadOptionSignals(t.worker.db, [spy])).get(spy)!;
    expect(
      signalAt(list, Date.parse('2026-11-24T21:30:00Z'), (ms) => nyDate(new Date(ms))),
    ).toBeUndefined();
  });
});

describe('the history rebuild (F7)', () => {
  let qqq: string;
  const SIGMA = 0.25;
  const today = '2026-11-02';
  const closeOf = (d: string) => 400 + 20 * Math.sin(Date.parse(d) / (86_400_000 * 30));

  /** Weekly contracts priced by Black-Scholes at 25% on the stock's close; each traded 12 times a day. */
  const fakeAlpaca = (): RebuildSource & { requests: number } => {
    const state = { requests: 0 };
    const contracts = (from: string, to: string, low: number, high: number) => {
      const out: OptionContractRef[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        if (new Date(`${d}T00:00:00Z`).getUTCDay() !== 5) continue;
        for (let k = Math.ceil(low / 5) * 5; k <= high; k += 5)
          for (const right of ['call', 'put'] as const)
            out.push({
              symbol: `QQQ${d.slice(2).replace(/-/g, '')}${right[0]!.toUpperCase()}${String(k * 1000).padStart(8, '0')}`,
              expiry: d,
              right,
              strike: k,
            });
      }
      return out;
    };
    let all: OptionContractRef[] = [];
    return {
      get requests() {
        return state.requests;
      },
      async contracts(q) {
        state.requests++;
        all = contracts(q.expirationGte, q.expirationLte, q.strikeGte ?? 0, q.strikeLte ?? 1e9);
        return all;
      },
      async bars(symbols, from, to) {
        state.requests++;
        const out = new Map<string, OptionBar[]>();
        for (const s of symbols) {
          const c = all.find((x) => x.symbol === s)!;
          const bars: OptionBar[] = [];
          for (const d of tradingDays(from, to)) {
            if (d >= c.expiry) continue;
            const T = (Date.parse(c.expiry) - Date.parse(d)) / 86_400_000 / 365;
            const price = bsmPrice(c.right, {
              S: closeOf(d),
              K: c.strike,
              T,
              r: 0.05,
              q: 0,
              sigma: SIGMA,
            });
            if (price < 0.05) continue;
            bars.push({
              t: `${d}T05:00:00Z`,
              o: price,
              h: price,
              l: price,
              c: price,
              v: 50,
              n: 12,
            });
          }
          out.set(s, bars);
        }
        return out;
      },
    };
  };

  beforeAll(async () => {
    qqq = await t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'etf',
        symbol: 'QQQ',
        venue: 'NASDAQ',
        displayName: 'Invesco QQQ Trust',
        provider: 'alpaca',
        providerId: 'qqq-test',
      }),
    );
    await addSeedUnderlyings(t.worker.db, [qqq]);
  });

  it('waits, saying why, without the app’s Alpaca key', async () => {
    const u = (await listOptionUniverse(t.worker.db)).find((x) => x.symbol === 'QQQ')!;
    const outcome = await rebuildUnderlying(
      {
        db: t.worker.db,
        inputs: inputsFrom(closeOf),
        source: undefined,
        logger: quiet,
        now: () => new Date(`${today}T23:00:00Z`),
      },
      u,
    );
    expect(outcome).toBe('waiting');
    expect((await listOptionUniverse(t.worker.db)).find((x) => x.symbol === 'QQQ')).toMatchObject({
      rebuildStatus: 'waiting',
      rebuildNote: expect.stringMatching(/OPTIONS_ALPACA_KEY_ID/),
    });
  });

  it('rebuilds a year of IV30 from option bars, marked rebuilt, with a usable IV rank', async () => {
    const u = (await listOptionUniverse(t.worker.db)).find((x) => x.symbol === 'QQQ')!;
    const alpaca = fakeAlpaca();
    const outcome = await rebuildUnderlying(
      {
        db: t.worker.db,
        inputs: inputsFrom(closeOf),
        source: alpaca,
        logger: quiet,
        now: () => new Date(`${today}T23:00:00Z`),
        historyDays: 400,
      },
      u,
    );
    expect(outcome).toBe('done');
    const list = (await loadOptionSignals(t.worker.db, [qqq])).get(qqq)!;
    expect(list.length).toBeGreaterThan(200);
    expect(list.every((s) => s.source === 'rebuilt')).toBe(true);
    const last = list.at(-1)!;
    expect(Math.abs((last.values.iv30 as number) - SIGMA)).toBeLessThan(0.002);
    expect(last.values.iv_rank_252d).not.toBeNull();
    expect(last.ivHistoryDays).toBeGreaterThanOrEqual(120);
    // No open interest or quotes in bars: those signals stay unknown.
    expect(last.values.net_gex).toBeNull();
    expect(last.values.put_call_oi).toBeNull();
    expect(last.values.straddle_move_pct).toBeNull();
    expect((await listOptionUniverse(t.worker.db)).find((x) => x.symbol === 'QQQ')).toMatchObject({
      rebuildStatus: 'done',
    });
    const [feed] =
      await t.ownerSql`select distinct feed from option_daily_signal where underlying_id = ${qqq}`;
    expect(feed?.feed).toBe('alpaca_bars');
  });
});
