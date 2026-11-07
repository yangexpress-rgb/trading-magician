import { describe, expect, it } from 'vitest';
import {
  SecClient,
  SecContactError,
  SecRefusedError,
  SecUnavailableError,
  type Fetch,
} from './client';
import {
  checkSec,
  fetchCompanyReport,
  fetchScreenFacts,
  fetchTickers,
  fiscalYears,
  normalizeTicker,
  recentFilings,
  sharesOutstanding,
} from './edgar';
import { FAKE_SEC_DATA_URL, FAKE_SEC_WWW_URL, FakeSec } from './testing';
import factsFixture from './testing/fixtures/companyfacts.json';
import submissionsFixture from './testing/fixtures/submissions.json';
import tickersFixture from './testing/fixtures/company-tickers-exchange.json';
import frameFixture from './testing/fixtures/frame.json';
import type { SecCompanyFacts, SecSubmissions } from './types';

const NOW = new Date('2026-11-05T15:00:00Z');

const client = (fetch: Fetch, contactEmail = 'yong@example.com') =>
  new SecClient({
    credentials: { contactEmail },
    fetch,
    wwwUrl: FAKE_SEC_WWW_URL,
    dataUrl: FAKE_SEC_DATA_URL,
    allowLocal: true,
    spacingMs: 0,
  });

const answer =
  (body: unknown, status = 200): Fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe('SEC client', () => {
  it('names the contact in the User-Agent and nowhere in logs', async () => {
    let agent = '';
    const c = client(async (_url, init) => {
      agent = new Headers(init.headers).get('user-agent') ?? '';
      return new Response('{}', { status: 200 });
    });
    await c.data('/x.json');
    expect(agent).toBe('TradingMagician/1.0 (yong@example.com)');
    expect(JSON.stringify(c)).not.toContain('yong@');
  });

  it('refuses a contact that is not an email, and hosts that are not the SEC', () => {
    expect(() => client(answer({}), 'not an email')).toThrow(SecContactError);
    expect(() => client(answer({}), 'a@b.co\r\nX-Evil: 1')).toThrow(SecContactError);
    expect(
      () =>
        new SecClient({ credentials: { contactEmail: 'a@b.co' }, dataUrl: 'https://evil.example' }),
    ).toThrow(/Refusing/);
  });

  it('maps 403 to a refusal and 429 or 5xx to try-again-later', async () => {
    await expect(client(answer('', 403)).data('/x')).rejects.toBeInstanceOf(SecRefusedError);
    await expect(client(answer('', 429)).data('/x')).rejects.toBeInstanceOf(SecUnavailableError);
    await expect(client(answer('', 503)).data('/x')).rejects.toBeInstanceOf(SecUnavailableError);
    await expect(
      client(async () => {
        throw new TypeError('fetch failed');
      }).data('/x'),
    ).rejects.toBeInstanceOf(SecUnavailableError);
  });
});

describe('reading EDGAR', () => {
  it('reads tickers with share classes as dots, the first listing per ticker winning', async () => {
    const tickers = await fetchTickers(client(answer(tickersFixture)));
    expect(tickers.get('BRK.B')).toMatchObject({ cik: '1067983', exchange: 'NYSE' });
    expect(tickers.get('GOOG')?.cik).toBe('1652044');
    expect(normalizeTicker(' brk-a ')).toBe('BRK.A');
  });

  it("gives a share class EDGAR's list leaves out its sibling's company (FOXA, NWSA)", async () => {
    const tickers = await fetchTickers(client(answer(tickersFixture)));
    expect(tickers.get('FOXA')).toMatchObject({ cik: '1754301', ticker: 'FOXA' });
    expect(tickers.get('BRK.A')?.cik).toBe('1067983');
    expect(tickers.get('NWSA')).toBeUndefined();
  });

  it('takes annual 10-K values per fiscal year, the latest filing winning', () => {
    const years = fiscalYears(factsFixture as unknown as SecCompanyFacts);
    expect(years.map((y) => [y.fiscalYear, y.end])).toEqual([
      [2024, '2024-09-28'],
      [2025, '2025-09-27'],
    ]);
    expect(years[1]).toMatchObject({
      revenue: 416_161_000_000,
      grossProfit: 195_201_000_000,
      netIncome: 112_010_000_000,
      eps: 7.46,
      equity: 73_733_000_000,
      operatingIncome: null,
    });
  });

  it('takes the latest cover-page share count', () => {
    expect(sharesOutstanding(factsFixture as unknown as SecCompanyFacts)).toEqual({
      value: 14_776_353_000,
      asOf: '2025-10-17',
    });
  });

  it('lists annual, quarterly and current reports with links, skipping insider forms', () => {
    const filings = recentFilings(submissionsFixture as SecSubmissions, 'https://www.sec.gov');
    expect(filings.map((f) => f.form)).toEqual(['10-K', '10-Q']);
    expect(filings[0]?.url).toBe(
      'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm',
    );
  });

  it('builds a company report from the fake EDGAR', async () => {
    const fake = new FakeSec({ now: () => NOW });
    const c = client(fake.fetch);
    const tickers = await fetchTickers(c);
    const report = await fetchCompanyReport(c, tickers.get('ZTSTA')!);
    expect(report).toMatchObject({
      symbol: 'ZTSTA',
      name: 'Test Alpha Inc.',
      cik: '9900001',
      profile: {
        industry: 'Services-Prepackaged Software',
        headquarters: 'Springfield, IL',
        fiscalYearEnd: '12-31',
        exchanges: ['Nasdaq'],
      },
      sharesOutstanding: { value: 250_000_000 },
    });
    expect(report.years).toHaveLength(5);
    expect(report.years.at(-1)?.fiscalYear).toBe(2025);
    expect(report.filings[0]?.form).toBe('10-K');
  });

  it('fills screener figures for the latest calendar year most companies reported', async () => {
    const fake = new FakeSec({ now: () => NOW });
    const c = client(fake.fetch);
    const { year, facts } = await fetchScreenFacts(c, await fetchTickers(c), NOW);
    expect(year).toBe(2025);
    const a = facts.get('ZTSTA')!;
    expect(a.revenue).toBeGreaterThan(a.revenuePrior!);
    expect(a.shares).toBe(250_000_000);
    expect(facts.get('ZTSTB')?.eps).toBeGreaterThan(0);
  });

  it('reads a frame as the fixture has it', async () => {
    const c = client(answer(frameFixture));
    const { facts } = await fetchScreenFacts(
      c,
      new Map([
        ['AAPL', { cik: '320193', name: 'Apple Inc.', ticker: 'AAPL', exchange: 'Nasdaq' }],
      ]),
      NOW,
    );
    expect(facts.get('AAPL')?.netIncome).toBe(112_010_000_000);
  });

  it('checks the feed with one small request, refused without a contact', async () => {
    const fake = new FakeSec({ now: () => NOW });
    await expect(checkSec(client(fake.fetch))).resolves.toEqual({ ok: true });
    const noContact: Fetch = (url, init) =>
      fake.fetch(url, { ...init, headers: { 'user-agent': 'node' } });
    await expect(checkSec(client(noContact))).rejects.toBeInstanceOf(SecRefusedError);
  });
});
