import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  changeDealStatus,
  createStrategy,
  getBacktest,
  insertDeal,
  latestRecordedCloses,
  listBacktestTrades,
  listDealFilings,
  listDeals,
  mergeDuplicateDeals,
  listScanStates,
  loadEventData,
  provisionWorkspace,
  recentReleases,
  registerInstrument,
  saveRates,
  schema,
  startBacktest,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  createDefinition,
  dealSpread,
  regularSession,
  tradingDays,
  type Bar,
  type Comparison,
  type Expr,
  type HistoricalDataProvider,
  type StrategyDefinition,
} from '@tm/domain';
import { fetchTickers, SecClient } from '@tm/sec';
import {
  FAKE_EVENTS_DATA_URL,
  FAKE_EVENTS_EFTS_URL,
  FAKE_EVENTS_WWW_URL,
  FAKE_ACQ,
  FAKE_TGT_DEAL,
  FakeEdgarEvents,
  fakeReleaseDay,
} from '@tm/sec/testing';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';
import { refreshDealCloses } from '../src/events/deal-closes';
import { scanDeals } from '../src/events/deals-tracker';
import { dealClosesDue, runEventsPass } from '../src/events/loop';

/**
 * Earnings, deals and rates end to end (free data feeds brief v1 §10): the
 * event jobs read the EDGAR stand-in, rebuild history back to February 2024,
 * and back tests of the PEAD and merger-arbitrage fixtures read it point in
 * time; a run before the history fails by name.
 */

let t: TestDatabase;
let userId: string;
let account: string;
let xyz: string;
let tgt: string;
let client: SecClient;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
/** Sunday evening, 8 November 2026: XYZ's latest release was Monday 2 November. */
const NOW = new Date('2026-11-08T23:45:00Z');
const fake = new FakeEdgarEvents({ now: () => NOW });

/** Daily bars: XYZ climbs gently; TGT trades at $47.50 from the deal's announcement. */
const provider: HistoricalDataProvider = {
  id: 'test-history',
  intervals: ['1d'],
  async getBars(req) {
    // A target the feed has no bars for (N151).
    if (req.symbol === 'NOBARS') return { bars: [], dataVersion: 'test-history@1', warnings: [] };
    const bars: Bar[] = tradingDays(req.from, req.to).flatMap((d, i) => {
      const s = regularSession(d);
      if (!s) return [];
      const price =
        req.symbol === 'TGT'
          ? d < FAKE_TGT_DEAL.announced
            ? 40
            : 47.5
          : req.symbol === 'ACA'
            ? 140
            : 100 + i * 0.05;
      const v = new Decimal(price);
      return [{ start: s.open, end: s.close, open: v, high: v, low: v, close: v, volume: v }];
    });
    return { bars, dataVersion: 'test-history@1', warnings: [] };
  },
};

let n = 0;
const uid = (p: string) => `${p}${++n}`;
const metric = (id: string, instrumentId: string): Expr => ({
  kind: 'metric',
  id: uid('m'),
  metric: id,
  params: {},
  instrumentId,
});
const constant = (value: string): Expr => ({ kind: 'constant', id: uid('c'), value });
const cmp = (
  id: string,
  left: Expr,
  operator: Comparison['operator'],
  right?: Expr,
): Comparison => ({
  kind: 'comparison',
  id,
  left,
  operator,
  ...(right ? { right } : {}),
});

function legs(def: StrategyDefinition, instrumentId: string) {
  const leg = {
    instrumentId,
    accountId: account,
    quantity: { type: 'units' as const, value: '10', rounding: 'down' as const },
    orderType: 'market' as const,
    timeInForce: 'day' as const,
    timing: { mode: 'immediate' as const },
  };
  def.entry.trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = [{ id: 'buy', legLabel: 'Buy', side: 'buy', ...leg }];
  def.exit.orders = [{ id: 'sell', legLabel: 'Sell', side: 'close', ...leg }];
}

/** PEAD (§7.1): days since earnings ≤ 5 and SUE > 1.0, out after 60 bars. */
function pead(): StrategyDefinition {
  const def = createDefinition();
  def.entry.condition.children = [
    cmp('days', metric('earnings.days_since_earnings', xyz), 'lte', constant('5')),
    cmp('sue', metric('earnings.sue_ts', xyz), 'gt', constant('1.0')),
  ];
  def.exit.condition.children = [
    cmp('never', metric('earnings.days_since_earnings', xyz), 'lt', constant('-1')),
  ];
  def.exit.rules = [{ kind: 'timeStop', id: 'ts', barsHeld: 60 }];
  legs(def, xyz);
  return def;
}

/** Merger arbitrage (§7.2): spread > 3%; out when the deal stops producing a spread, or at 120 bars. */
function mergerArb(): StrategyDefinition {
  const def = createDefinition();
  def.entry.condition.children = [
    cmp('spread', metric('deals.spread_pct', tgt), 'gt', constant('0.03')),
  ];
  def.exit.condition.children = [
    {
      kind: 'group',
      id: 'no-deal',
      op: 'and',
      negate: true,
      children: [cmp('live', metric('deals.spread_pct', tgt), 'is_available')],
    },
  ];
  def.exit.rules = [{ kind: 'timeStop', id: 'ts', barsHeld: 120 }];
  legs(def, tgt);
  return def;
}

/** The deal targets' daily closes, through the same bars back tests read (N151). */
const dealBars = async (symbol: string, from: string, to: string) =>
  (
    await provider.getBars({
      instrumentId: symbol,
      symbol,
      assetClass: 'stock',
      interval: '1d',
      from,
      to,
      adjustment: 'none',
      session: 'regular',
    })
  ).bars;

beforeAll(async () => {
  t = await createTestDatabase();
  const register = (symbol: string) =>
    t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'stock',
        symbol,
        venue: 'NYSE',
        displayName: symbol,
        provider: 'alpaca',
        providerId: `${symbol}-test`,
      }),
    );
  xyz = await register('XYZ');
  tgt = await register('TGT');
  client = new SecClient({
    credentials: { contactEmail: 'events-test@example.test' },
    fetch: fake.fetch,
    wwwUrl: FAKE_EVENTS_WWW_URL,
    dataUrl: FAKE_EVENTS_DATA_URL,
    eftsUrl: FAKE_EVENTS_EFTS_URL,
    allowLocal: true,
    spacingMs: 0,
  });
  await runEventsPass({
    db: t.worker.db,
    client,
    tickers: (c) => fetchTickers(c),
    calendar: async () => [],
    refreshRates: (today) =>
      saveRates(
        t.worker.db,
        [
          { date: '2024-01-02', rate: 0.0525 },
          { date: today, rate: 0.0412 },
        ],
        '2024-01-01',
      ),
    logger: quiet,
    now: () => NOW,
    symbols: ['XYZ', 'TGT', 'LOWC'],
    dealBars: dealBars,
  });
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'e', email: 'events@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'E' });
  account = (await asUser((tx) => tx.select().from(schema.tradingAccounts)))[0]!.id;
  await t.ownerSql`update trading_account
    set capabilities = jsonb_set(capabilities, '{coverage}', '"us"') where id = ${account}`;
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

describe('the earnings scan (§5.2, §10 item 1)', () => {
  it('finds the known recent release from its 8-K Item 2.02', async () => {
    const latest = (await recentReleases(t.app.db, 'XYZ', 1))[0];
    expect(latest).toMatchObject({
      fiscalQuarterEnd: '2026-09-30',
      announcedDate: fakeReleaseDay('2026-09-30'),
      reportedEps: 2.5,
      epsQMinus4: 2.25,
      diffSd: 0.1,
      sue: 2.5,
      sueSource: 'rebuilt',
    });
    expect(latest?.announcedDate).toBe('2026-11-02');
    expect(latest?.filingUrl).toMatch(
      /\/Archives\/edgar\/data\/9910001\/.+xyz-8k-2026-11-02\.htm$/,
    );
  });

  it('rebuilds history back to February 2024 and no further', async () => {
    const all = await recentReleases(t.app.db, 'XYZ', 100);
    expect(all.at(-1)!.announcedDate >= '2024-02-01').toBe(true);
    expect(all.at(-1)!.announcedDate <= '2024-02-29').toBe(true);
    // The derived fourth quarters count too: no quarter is missing.
    expect(all.length).toBe(12);
    const states = await listScanStates(t.app.db);
    expect(states.find((s) => s.job === 'earnings_rebuild')).toMatchObject({
      status: 'done',
      coveredFrom: '2024-02-01',
    });
    expect(states.find((s) => s.job === 'calendar')?.status).toBe('skipped');
  });
});

describe('the deal tracker (§5.3, §10 item 2)', () => {
  it("finds the known deal from the target's 8-K and follows it to closing", async () => {
    const deals = await listDeals(t.app.db);
    const d = deals.find((x) => x.targetSymbol === 'TGT');
    expect(d).toMatchObject({
      dealId: 'D00001',
      acquirerName: 'Acquirer Holdings Inc.',
      offerPrice: 50,
      consideration: 'cash',
      confidence: 'high',
      status: 'closed',
      announcedDate: FAKE_TGT_DEAL.announced,
    });
    const history = await t.app.db.select().from(schema.dealStatusHistory);
    expect(history.map((h) => [h.oldStatus, h.newStatus, h.changedDate])).toEqual([
      ['announced', 'pending', FAKE_TGT_DEAL.proxy],
      ['pending', 'closed', FAKE_TGT_DEAL.closed],
    ]);
  });

  it('keeps a deal with no price as low-confidence with a null spread', async () => {
    const d = (await listDeals(t.app.db)).find((x) => x.targetSymbol === 'LOWC');
    expect(d).toMatchObject({ dealId: 'D00002', confidence: 'low', offerPrice: null });
  });

  it('still reads the options recording closes for the options pages', async () => {
    await t.ownerSql`
      insert into option_daily_signal (underlying_id, as_of_date, underlying_close, source, feed, computed_at)
      values (${tgt}, '2026-11-06', 47.5, 'recorded', 'cboe', now())`;
    const closes = await latestRecordedCloses(t.app.db, ['TGT', 'LOWC']);
    expect(closes.get('TGT')).toEqual({ close: 47.5, date: '2026-11-06' });
    expect(closes.has('LOWC')).toBe(false);
  });

  it('is append-only and worker-written', async () => {
    const denied = async (p: Promise<unknown>) => {
      const e = await p.then(
        () => undefined,
        (err: { cause?: { message?: string } }) => err,
      );
      expect(e?.cause?.message).toMatch(/permission denied/);
    };
    await denied(t.worker.db.execute(`update deal_status_history set new_status = 'withdrawn'`));
    await denied(t.app.db.execute(`delete from deal_event`));
  });
});

describe('one deal, several filings (N152) and daily closes (N151)', () => {
  const tracker = () => ({
    db: t.worker.db,
    client,
    tickers: () => fetchTickers(client),
    logger: quiet,
    now: () => NOW,
  });
  const dealRows = async () =>
    Number((await t.ownerSql<{ n: string }[]>`select count(*)::text as n from deal_event`)[0]!.n);

  it("links the acquirer's filing of TGT's deal to the target's: one deal, both filings", async () => {
    const deals = (await listDeals(t.app.db)).filter((d) => d.targetName.startsWith('Target'));
    expect(deals).toHaveLength(1);
    const filings = await listDealFilings(t.app.db, deals);
    expect(filings.get(deals[0]!.dealId)!.map((f) => f.accession)).toEqual([
      '0009910002-25-000101',
      '0009910004-25-000301',
    ]);
    expect(filings.get(deals[0]!.dealId)![1]!.url).toContain(`/${FAKE_ACQ.cik}/`);
  });

  it('a re-scan of the same dates creates no new deal rows', async () => {
    const before = await dealRows();
    const counts = await scanDeals(tracker(), 'deals_scan', '2024-02-01', '2026-11-08');
    expect(counts.added).toBe(0);
    expect(counts.failed).toBe(0);
    expect(await dealRows()).toBe(before);
  });

  it('folds two stored rows of one deal into one, keeping both filings and the status history', async () => {
    // As on staging: the acquirer's filing named the target without a listing,
    // the target's own filing gave the symbol (D00933 and D00935).
    const acq = await insertDeal(t.worker.db, {
      targetSymbol: null,
      targetCik: null,
      targetName: 'Arcosa',
      acquirerName: 'CRH PUBLIC LTD CO',
      announcedDate: '2026-06-22',
      announcedAt: '2026-06-22T12:00:00.000Z',
      offerPrice: 150,
      consideration: 'cash',
      sourceFilingUrl: 'https://www.sec.gov/Archives/edgar/data/849395/crh-8k.htm',
      accession: '0000849395-26-000001',
      confidence: 'low',
      parseNote: 'target not listed, or not matched to a listing',
      source: 'recorded',
    });
    const target = await insertDeal(t.worker.db, {
      targetSymbol: 'ACA',
      targetCik: '1739445',
      targetName: 'Arcosa, Inc.',
      acquirerName: 'Company, CRH Americas, Inc.',
      announcedDate: '2026-06-22',
      announcedAt: '2026-06-22T20:30:00.000Z',
      offerPrice: 150,
      consideration: 'cash',
      sourceFilingUrl: 'https://www.sec.gov/Archives/edgar/data/1739445/aca-8k.htm',
      accession: '0001739445-26-000001',
      confidence: 'high',
      parseNote: null,
      source: 'recorded',
    });
    // A deal genuinely different only by price stays its own deal.
    const other = await insertDeal(t.worker.db, {
      targetSymbol: 'ACA',
      targetCik: '1739445',
      targetName: 'Arcosa, Inc.',
      acquirerName: 'Someone Else',
      announcedDate: '2026-06-22',
      announcedAt: '2026-06-22T20:30:00.000Z',
      offerPrice: 155,
      consideration: 'cash',
      sourceFilingUrl: 'https://www.sec.gov/Archives/edgar/data/1739445/other.htm',
      accession: '0001739445-26-000002',
      confidence: 'high',
      parseNote: null,
      source: 'recorded',
    });
    await changeDealStatus(t.worker.db, {
      dealId: acq,
      newStatus: 'pending',
      changedAt: '2026-08-01T12:00:00.000Z',
      changedDate: '2026-08-01',
      sourceFilingUrl: 'https://www.sec.gov/Archives/edgar/data/1739445/proxy.htm',
      accession: '0001739445-26-000050',
    });

    expect(await mergeDuplicateDeals(t.worker.db)).toEqual([{ kept: target, merged: acq }]);
    // Running it again changes nothing.
    expect(await mergeDuplicateDeals(t.worker.db)).toEqual([]);

    const all = await listDeals(t.app.db, { active: false });
    const arcosa = all.filter((d) => d.announcedDate === '2026-06-22' && d.offerPrice === 150);
    expect(arcosa.map((d) => d.dealId)).toEqual([target]);
    expect(arcosa[0]).toMatchObject({ targetSymbol: 'ACA', confidence: 'high', status: 'pending' });
    expect(all.some((d) => d.dealId === other)).toBe(true);
    expect(all.some((d) => d.dealId === acq)).toBe(false);
    const filings = (await listDealFilings(t.app.db, arcosa)).get(target)!;
    expect(filings.map((f) => f.accession)).toEqual([
      '0001739445-26-000001',
      '0000849395-26-000001',
    ]);
    const history = await t.ownerSql<{ deal_id: string; new_status: string }[]>`
      select deal_id, new_status from deal_status_history where deal_id in (${acq}, ${target})
      order by deal_id`;
    expect(history).toEqual([
      { deal_id: acq, new_status: 'pending' },
      { deal_id: target, new_status: 'pending' },
    ]);
    // The hidden row keeps its id, so a later deal never takes it.
    const merged = await t.ownerSql<{ merged_into: string }[]>`
      select merged_into from deal_event where deal_id = ${acq}`;
    expect(merged[0]!.merged_into).toBe(target);

    // The merged filing is read: a re-scan or another pass adds nothing.
    const before = await dealRows();
    await runEventsPass({
      db: t.worker.db,
      client,
      tickers: (c) => fetchTickers(c),
      calendar: async () => [],
      refreshRates: async () => undefined,
      logger: quiet,
      now: () => NOW,
      symbols: ['XYZ', 'TGT', 'LOWC'],
      dealBars,
    });
    expect(await dealRows()).toBe(before);
  });

  it('gives every active target a close from its daily bars, and a spread for a high-confidence cash deal', async () => {
    const noBars = await insertDeal(t.worker.db, {
      targetSymbol: 'NOBARS',
      targetCik: '1999999',
      targetName: 'No Bars Corp.',
      acquirerName: 'Buyer Inc.',
      announcedDate: '2026-10-01',
      announcedAt: '2026-10-01T12:00:00.000Z',
      offerPrice: 20,
      consideration: 'cash',
      sourceFilingUrl: 'https://www.sec.gov/Archives/edgar/data/1999999/nobars.htm',
      accession: '0001999999-26-000001',
      confidence: 'high',
      parseNote: null,
      source: 'recorded',
    });
    const counts = await refreshDealCloses({
      db: t.worker.db,
      bars: dealBars,
      logger: quiet,
      now: NOW,
    });
    expect(counts.failed).toBe(0);
    const deals = await listDeals(t.app.db);
    const aca = deals.find((d) => d.targetSymbol === 'ACA' && d.offerPrice === 150)!;
    // ACA is not an options underlying: its close comes from its daily bars.
    expect(aca).toMatchObject({ lastClose: 140, lastCloseDate: '2026-11-06' });
    const spread = dealSpread({ ...aca, changes: [] }, aca.lastClose ?? undefined);
    expect(spread).toBeCloseTo((150 - 140) / 140, 10);
    // A target with no bars shows no close, never a zero.
    expect(deals.find((d) => d.dealId === noBars)).toMatchObject({
      lastClose: null,
      lastCloseDate: null,
    });
    // A low-confidence deal gets a close but no spread.
    const lowc = deals.find((d) => d.targetSymbol === 'LOWC')!;
    expect(lowc.lastClose).toBeGreaterThan(0);
    expect(dealSpread({ ...lowc, changes: [] }, lowc.lastClose ?? undefined)).toBeUndefined();
    const state = (await listScanStates(t.app.db)).find((s) => s.job === 'deal_closes');
    expect(state).toMatchObject({ status: 'done', coveredTo: '2026-11-08' });
  });

  it('refreshes the closes once a day and again after the evening close', () => {
    const at = (iso: string) => new Date(iso);
    expect(dealClosesDue(undefined, at('2026-11-09T15:00:00Z'))).toBe(true);
    const morning = { status: 'done', lastRunAt: at('2026-11-09T14:00:00Z') };
    expect(dealClosesDue(morning, at('2026-11-09T20:00:00Z'))).toBe(false);
    expect(dealClosesDue(morning, at('2026-11-09T23:45:00Z'))).toBe(true);
    const evening = { status: 'done', lastRunAt: at('2026-11-09T23:45:00Z') };
    expect(dealClosesDue(evening, at('2026-11-10T00:30:00Z'))).toBe(false);
    expect(dealClosesDue(evening, at('2026-11-10T14:00:00Z'))).toBe(true);
    const failed = { status: 'failed', lastRunAt: at('2026-11-09T14:00:00Z') };
    expect(dealClosesDue(failed, at('2026-11-09T14:30:00Z'))).toBe(false);
    expect(dealClosesDue(failed, at('2026-11-09T15:00:00Z'))).toBe(true);
  });
});

describe('back tests of the Lab fixtures', () => {
  const run = async (def: StrategyDefinition, from: string, to: string) => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: uid('fixture'), definition: def }),
    );
    const r = await asUser((tx) =>
      startBacktest(tx, userId, s.id, { ...DEFAULT_BACKTEST_INPUTS, from, to }),
    );
    await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet });
    return asUser((tx) => getBacktest(tx, r.id));
  };

  it('PEAD runs over February 2024 – November 2026 without a "no data" error', async () => {
    const done = await run(pead(), '2024-02-01', '2026-11-06');
    expect(done.error).toBeNull();
    expect(done.status).toBe('completed');
    expect(done.metrics?.cycles).toBeGreaterThan(0);
    const fired = done.result?.conditions?.entry.bars.filter((b) => b.outcome === 'fired') ?? [];
    const read = fired.flatMap((b) => b.checks.find((c) => c.id === 'sue')?.eventsAsOf ?? []);
    expect(read.some((x) => x.endsWith('(rebuilt history)'))).toBe(true);
  });

  it('a PEAD run entirely before February 2024 fails with the named message', async () => {
    const done = await run(pead(), '2023-06-01', '2023-12-29');
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/^No earnings data for XYZ before 2024-02-\d\d$/);
  });

  it('merger arbitrage runs over February 2024 – November 2026 and exits after closing', async () => {
    const done = await run(mergerArb(), '2024-02-01', '2026-11-06');
    expect(done.error).toBeNull();
    expect(done.metrics?.cycles).toBe(1);
    const [trade] = await asUser((tx) => listBacktestTrades(tx, done.id));
    expect(trade?.exitReason).toBe('condition');
    expect(new Date(trade!.exitTime!).toISOString().slice(0, 10) > FAKE_TGT_DEAL.closed).toBe(true);
  });

  it('loads every event kind a strategy reads, by instrument', async () => {
    const data = await loadEventData(
      t.app.db,
      new Map([
        [xyz, new Set(['earnings.sue_ts', 'rates.tbill_3m'])],
        [tgt, new Set(['deals.spread_pct'])],
      ]),
    );
    expect(data.earnings.get(xyz)?.length).toBe(12);
    expect(data.deals.get(tgt)?.[0]?.offerPrice).toBe(50);
    expect(data.rates.at(-1)).toEqual({ date: '2026-11-08', tbill3m: 0.0412 });
    expect(data.dealsFrom).toBe('2024-02-01');
  });
});
