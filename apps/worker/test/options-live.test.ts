import {
  addSeedUnderlyings,
  createFeed,
  latestSignalsBySymbol,
  registerInstrument,
  saveOptionSignal,
  getLiveChain,
  IntegrationError,
  provisionWorkspace,
  requestLiveChain,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  CboeOptionsFormatError,
  expectedMoveCone,
  OPTION_SIGNAL_FIELDS,
  screenOptionColumns,
  type Bar,
  type OptionSignalValues,
} from '@tm/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cboeOptionsSource, type ChainSource } from '../src/options/cboe-options';
import { fakeCboeOptionsFetch } from '../src/options/cboe-options-fake';
import { answerLiveChains, type LiveChainOptions } from '../src/options/live-chain';
import type { MarketInputs } from '../src/options/market-inputs';

/**
 * The on-demand live chain (options data brief v2 §10 item 8, ADR 0048): the
 * app asks, the worker prices the chain with the app's own model and keeps
 * the view for 15 minutes; only computed values reach the view.
 */

let t: TestDatabase;
let userId: string;
const quiet = { info: () => undefined, warn: () => undefined };
const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);

const NOW = new Date('2026-11-06T21:30:00Z');
const fake = cboeOptionsSource({
  fetch: fakeCboeOptionsFetch(
    () => NOW,
    () => 600,
  ),
});
const chains: ChainSource = {
  feed: 'cboe',
  async chain(symbol) {
    if (symbol === 'ZZZZ') throw new CboeOptionsFormatError('CBOE has no options file for ZZZZ');
    return fake.chain(symbol);
  },
};
const inputs: MarketInputs = {
  hasCloses: false,
  dailyBars: async (): Promise<Bar[]> => [],
  riskFreeRate: async () => 0.04,
};
const options = (): LiveChainOptions => ({
  db: t.worker.db,
  chains,
  inputs,
  logger: quiet,
  now: () => NOW,
});

beforeAll(async () => {
  t = await createTestDatabase();
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'l', email: 'options-live@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'L' });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('the live chain', () => {
  it('needs the options feed', async () => {
    await expect(asUser((tx) => requestLiveChain(tx, 'SPY'))).rejects.toBeInstanceOf(
      IntegrationError,
    );
    await asUser((tx) =>
      createFeed(tx, {
        userId,
        name: 'CBOE delayed options (daily)',
        provider: 'cboe_options',
        assetClasses: ['stock', 'etf'],
      }),
    );
  });

  it('is computed by the worker and holds no source quote or greek', async () => {
    const asked = await asUser((tx) => requestLiveChain(tx, 'spy'));
    expect(asked).toMatchObject({ symbol: 'SPY', status: 'pending', view: null });
    expect(await answerLiveChains(options())).toBe(1);
    const ready = await asUser((tx) => getLiveChain(tx, 'SPY'));
    expect(ready?.status).toBe('ready');
    const view = ready!.view!;
    expect(view.underlyingPrice).toBe(600);
    expect(view.priceSource).toBe('chain');
    expect(view.feed).toBe('cboe');
    expect(view.expiries.length).toBeGreaterThan(3);
    // The fake prices on a 20%+ smile, so the computed ATM IV is about 0.2.
    expect(view.values.iv30).toBeGreaterThan(0.15);
    expect(view.values.iv30).toBeLessThan(0.3);
    expect(view.values.expected_move_5d_pct).toBeCloseTo(view.values.iv30! * Math.sqrt(5 / 365), 9);
    const strike = view.expiries[0]!.strikes.find((s) => s.call?.iv != null)!;
    expect(strike.call!.delta).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toMatch(/"bid"|"ask"|"last"|"theo"|"vega"|"theta"/);
    expect(expectedMoveCone(view).length).toBeGreaterThan(1);
  });

  it('reuses the view for 15 minutes, then refreshes it keeping the old one meanwhile', async () => {
    const again = await asUser((tx) => requestLiveChain(tx, 'SPY'));
    expect(again.status).toBe('ready');
    expect(await answerLiveChains(options())).toBe(0);
    await t.ownerSql`update option_live_chain set finished_at = now() - interval '16 minutes'`;
    const stale = await asUser((tx) => requestLiveChain(tx, 'SPY'));
    expect(stale.status).toBe('pending');
    expect(stale.view).not.toBeNull();
    expect(await answerLiveChains(options())).toBe(1);
  });

  it('says why a chain could not be had', async () => {
    await asUser((tx) => requestLiveChain(tx, 'ZZZZ'));
    await answerLiveChains(options());
    const failed = await asUser((tx) => getLiveChain(tx, 'ZZZZ'));
    expect(failed).toMatchObject({
      status: 'failed',
      message: 'CBOE has no options file for ZZZZ',
    });
  });

  it("keeps the app's login from writing the cache", async () => {
    await expect(
      asUser((tx) => tx.insert(schema.optionLiveChains).values({ symbol: 'QQQ' })),
    ).rejects.toThrow();
    await expect(asUser((tx) => requestLiveChain(tx, 'not a ticker!'))).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });
});

describe('the screener’s options columns (brief §10 item 9)', () => {
  it('read each recorded underlying’s latest daily signal, in screener units', async () => {
    const qqq = await t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'etf',
        symbol: 'QQQ',
        venue: 'NASDAQ',
        displayName: 'Invesco QQQ Trust',
        provider: 'alpaca',
        providerId: 'qqq-live-test',
      }),
    );
    await addSeedUnderlyings(t.worker.db, [qqq]);
    const nulls = Object.fromEntries(
      OPTION_SIGNAL_FIELDS.map((f) => [f, null]),
    ) as OptionSignalValues;
    for (const [day, iv] of [
      ['2026-11-05', 0.18],
      ['2026-11-06', 0.21],
    ] as const) {
      await saveOptionSignal(t.worker.db, {
        underlyingId: qqq,
        asOfDate: day,
        values: {
          ...nulls,
          iv30: iv,
          iv_rank_252d: 42.5,
          expected_move_5d_pct: 0.0246,
          skew_30d: 0.031,
        },
        ivHistoryDays: 200,
        expiries: [],
        underlyingClose: 500,
        riskFreeRate: 0.04,
        dividendYield: 0,
        source: 'recorded',
        feed: 'cboe',
        computedAt: new Date(),
      });
    }
    const latest = await asUser((tx) => latestSignalsBySymbol(tx, '2026-10-20'));
    expect(latest.get('QQQ')?.date).toBe('2026-11-06');
    expect(screenOptionColumns(latest.get('QQQ')!.values)).toEqual({
      iv30Pct: 21,
      ivRank: 42.5,
      expectedMove1wPct: 2.46,
      ivRvRatio: null,
      skewPts: 3.1,
      termStructure: null,
      putCallOi: null,
    });
  });
});
