import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  createCredential,
  createFeed,
  generateCredentialKeyPair,
  getCompanyReport,
  getStockScreenData,
  listFeeds,
  listRoutes,
  provisionWorkspace,
  requestCompanyReport,
  requestStockScreen,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { fromScreenTuple } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { FAKE_SEC_DATA_URL, FAKE_SEC_WWW_URL, FakeSec } from '@tm/sec/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider } from '../src/alpaca';
import { runCompanyReports } from '../src/company-reports';
import { runFeedChecks } from '../src/feed-checks';
import { fundamentalsLoader } from '../src/fundamentals';
import { demoProvider, type FundamentalsRegistry, type ProviderRegistry } from '../src/providers';
import { secProvider } from '../src/sec';
import { runStockScreens } from '../src/stock-screens';

/**
 * Company data feeds (ADR 0031): a separate kind of feed with no routes, a
 * queued company page per symbol, and company columns in the screener.
 */

let t: TestDatabase;
let user: string;
let other: string;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined };
/** Tuesday 2026-10-06, 11:00 New York. */
const NOW = new Date('2026-10-06T15:00:00Z');
const alpaca = new FakeAlpaca({ now: () => NOW });
const sec = new FakeSec({ now: () => NOW });
const providers: ProviderRegistry = {
  demo: demoProvider(
    (now) => createDemoLiveFeed({ now }),
    (now) => createDemoHistoryProvider({ now }),
  ),
  alpaca: alpacaProvider({
    fetch: alpaca.fetch,
    fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
    sleep: async () => {},
  }),
};
const fundamentals: FundamentalsRegistry = {
  sec: secProvider({
    fetch: sec.fetch,
    fake: { wwwUrl: FAKE_SEC_WWW_URL, dataUrl: FAKE_SEC_DATA_URL },
    spacingMs: 0,
  }),
};
const opts = {
  providers,
  fundamentals,
  privateKey: keys.privateKey,
  logger: quiet,
  now: () => NOW,
};
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Companies', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Companies' });
  return row!.id;
}

async function addSecFeed(userId: string, contactEmail: string) {
  return as(userId, async (tx) => {
    const credential = await createCredential(tx, {
      userId,
      provider: 'sec',
      label: 'SEC EDGAR contact',
      fields: { contactEmail },
      publicKey: keys.publicKey,
    });
    return createFeed(tx, {
      userId,
      name: 'SEC EDGAR',
      provider: 'sec',
      credentialId: credential.id,
      assetClasses: ['stock'],
    });
  });
}

async function company(userId: string, symbol: string) {
  const started = await as(userId, (tx) => requestCompanyReport(tx, { userId, symbol }));
  await runCompanyReports({ db: t.worker.db, ...opts });
  return as(userId, (tx) => getCompanyReport(tx, started.id));
}

beforeAll(async () => {
  t = await createTestDatabase();
  user = await createUser('companies-a@example.test');
  other = await createUser('companies-b@example.test');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('company data feeds', () => {
  it('asks for a company data feed before any company page', async () => {
    await expect(
      as(user, (tx) => requestCompanyReport(tx, { userId: user, symbol: 'ZTSTA' })),
    ).rejects.toThrow(/company data feed/);
  });

  it('adds SEC EDGAR as a company data feed with no routes, and checks it', async () => {
    const feed = await addSecFeed(user, 'research@example.test');
    expect(feed.provider).toBe('sec');
    expect(feed.routes).toEqual([]);
    // It never becomes a price route.
    const routes = await as(user, (tx) => listRoutes(tx));
    expect(routes.every((r) => r.primary.id !== feed.id)).toBe(true);
    await runFeedChecks({ db: t.worker.db, ...opts });
    const [checked] = (await as(user, (tx) => listFeeds(tx))).filter((f) => f.id === feed.id);
    expect(checked).toMatchObject({ health: 'healthy', entitlement: 'entitled', lastError: null });
  });

  it('fills a company page: profile, five fiscal years and filings', async () => {
    const done = await company(user, 'ztsta');
    expect(done.status).toBe('ready');
    expect(done.source).toBe('SEC EDGAR');
    expect(done.report).toMatchObject({
      symbol: 'ZTSTA',
      name: 'Test Alpha Inc.',
      profile: { industry: 'Services-Prepackaged Software', headquarters: 'Springfield, IL' },
    });
    expect(done.report!.years).toHaveLength(5);
    expect(done.report!.years.at(-1)!.revenue).toBeGreaterThan(done.report!.years[0]!.revenue!);
    expect(done.report!.filings[0]!.url).toMatch(/^http:\/\/sec\.test\/Archives\/edgar\/data\//);
    // A page from today is shown again rather than asked for twice.
    const again = await as(user, (tx) =>
      requestCompanyReport(tx, { userId: user, symbol: 'ZTSTA' }),
    );
    expect(again.id).toBe(done.id);
  });

  it('says so when the feed has no such company, such as an ETF', async () => {
    const done = await company(user, 'ZTSTX');
    expect(done.status).toBe('failed');
    expect(done.message).toMatch(/no company filings for ZTSTX/);
  });

  it('keeps each person’s company pages to themselves', async () => {
    const mine = await as(user, (tx) =>
      requestCompanyReport(tx, { userId: user, symbol: 'ZTSTA' }),
    );
    await expect(as(other, (tx) => getCompanyReport(tx, mine.id))).rejects.toThrow(
      /No such company page/,
    );
  });

  it('reports a refused contact as the feed’s health', async () => {
    const feed = await addSecFeed(other, 'not-an-email');
    await runFeedChecks({ db: t.worker.db, ...opts });
    const [checked] = (await as(other, (tx) => listFeeds(tx))).filter((f) => f.id === feed.id);
    expect(checked?.health).toBe('down');
    expect(checked?.lastError).toMatch(/contact email/);
  });

  it('adds market cap, P/E, earnings and dividend yield to the screener', async () => {
    await as(user, async (tx) => {
      const credential = await createCredential(tx, {
        userId: user,
        provider: 'alpaca',
        label: 'Alpaca paper',
        fields: { keyId: alpaca.credentials.keyId, secretKey: alpaca.credentials.secretKey },
        publicKey: keys.publicKey,
      });
      await createFeed(tx, {
        userId: user,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialId: credential.id,
        assetClasses: ['stock', 'etf'],
      });
    });
    const started = await as(user, (tx) => requestStockScreen(tx, { userId: user }));
    // P/E, dividend yield, P/B and EV/EBITDA come from point-in-time filings (v1.2 item 6).
    const filings = fundamentalsLoader({
      db: t.worker.db,
      fundamentals,
      privateKey: keys.privateKey,
      now: () => NOW,
    });
    await runStockScreens({ db: t.worker.db, ...opts, filings });
    const done = await as(user, (tx) => getStockScreenData(tx, started.id));
    expect(done.status).toBe('ready');
    expect(done.warnings.join(' ')).toMatch(/calendar 2025, from SEC EDGAR/);
    const rows = done.rows!.map(fromScreenTuple);
    const a = rows.find((r) => r.symbol === 'ZTSTA')!;
    expect(a.marketCap).toBe(Math.round(a.last! * 250_000_000));
    expect(a.pe).toBeGreaterThan(0);
    // Test Alpha pays no dividend (a 0% yield, Yong 2026-11-07); Test Beta declares one.
    expect(a.dividendYieldPct).toBe(0);
    const b = rows.find((r) => r.symbol === 'ZTSTB')!;
    expect(b.dividendYieldPct).toBeGreaterThan(0);
    expect(b.priceToBook).toBeGreaterThan(0);
    expect(b.evEbitda).toBeGreaterThan(0);
    expect(a.revenueGrowthPct).toBeCloseTo(12, 0);
    expect(a.netMarginPct).toBeCloseTo(18, 0);
    // ETFs have no company figures.
    expect(rows.find((r) => r.symbol === 'ZTSTX')!.marketCap).toBeNull();
  });
});
