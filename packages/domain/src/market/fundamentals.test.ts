import { describe, expect, it } from 'vitest';
import {
  companyMetrics,
  marketCapOf,
  peOf,
  screenFundamentals,
  type CompanyReport,
  type FiscalYearFacts,
} from './fundamentals';
import { fromScreenTuple, screenRow, toScreenTuple, type ScreenRowTuple } from './screen';

const year = (fiscalYear: number, values: Partial<FiscalYearFacts>): FiscalYearFacts => ({
  fiscalYear,
  end: `${fiscalYear}-12-31`,
  revenue: null,
  grossProfit: null,
  operatingIncome: null,
  netIncome: null,
  eps: null,
  dividendsPerShare: null,
  operatingCashFlow: null,
  capitalExpenditure: null,
  totalAssets: null,
  totalLiabilities: null,
  equity: null,
  cash: null,
  longTermDebt: null,
  dilutedShares: null,
  ...values,
});

const report = (years: FiscalYearFacts[], shares: number | null = 100): CompanyReport => ({
  symbol: 'TEST',
  name: 'Test Inc.',
  cik: '1',
  profile: {
    industry: null,
    sic: null,
    tickers: ['TEST'],
    exchanges: [],
    fiscalYearEnd: null,
    incorporatedIn: null,
    headquarters: null,
    phone: null,
    website: null,
    filerCategory: null,
    formerNames: [],
  },
  sharesOutstanding: shares === null ? null : { value: shares, asOf: '2026-01-31' },
  years,
  filings: [],
  currency: 'USD',
  sourceUrl: null,
});

describe('company metrics', () => {
  it('values the latest fiscal year at a price', () => {
    const m = companyMetrics(
      report([
        year(2024, { revenue: 800 }),
        year(2025, {
          revenue: 1000,
          grossProfit: 400,
          operatingIncome: 250,
          netIncome: 200,
          eps: 2,
          equity: 500,
          longTermDebt: 250,
          operatingCashFlow: 300,
          capitalExpenditure: 50,
          dividendsPerShare: 1,
        }),
      ]),
      40,
    );
    expect(m).toEqual({
      marketCap: 4000,
      pe: 20,
      ps: 4,
      pb: 8,
      revenueGrowthPct: 25,
      grossMarginPct: 40,
      operatingMarginPct: 25,
      netMarginPct: 20,
      roePct: 40,
      debtToEquity: 0.5,
      freeCashFlow: 250,
      dividendYieldPct: 2.5,
    });
  });

  it('leaves out what it cannot work out', () => {
    const m = companyMetrics(
      report([year(2025, { revenue: 1000, netIncome: -50, eps: -0.5 })], null),
      null,
    );
    expect(m.marketCap).toBeNull();
    expect(m.pe).toBeNull();
    expect(m.netMarginPct).toBe(-5);
    expect(m.revenueGrowthPct).toBeNull();
  });

  it('gives no P/E for losses and no market cap without shares', () => {
    expect(peOf(10, -1)).toBeNull();
    expect(peOf(10, 0.5)).toBe(20);
    expect(marketCapOf(10, null)).toBeNull();
  });
});

describe('screener company columns', () => {
  it('works out market cap and margins from a year of figures, and takes P/E from filings', () => {
    const facts = {
      year: 2025,
      revenue: 1000,
      revenuePrior: 900,
      netIncome: 100,
      eps: 1,
      shares: 100,
    };
    expect(screenFundamentals(facts, 25)).toEqual({
      marketCap: 2500,
      // P/E, dividend yield, P/B and EV/EBITDA come from the registry over filings (v1.2 item 6).
      pe: null,
      dividendYieldPct: null,
      priceToBook: null,
      evEbitda: null,
      revenue: 1000,
      revenueGrowthPct: 11.11,
      netIncome: 100,
      netMarginPct: 10,
      eps: 1,
    });
    expect(
      screenFundamentals(facts, 25, {
        pe: 20,
        dividendYieldPct: 3.2,
        priceToBook: 4,
        evEbitda: 11,
      }),
    ).toMatchObject({ pe: 20, dividendYieldPct: 3.2, priceToBook: 4, evEbitda: 11 });
  });

  it('round-trips the company columns, and reads older tuples as having none', () => {
    const row = screenRow(
      {
        symbol: 'A',
        name: 'A Inc.',
        assetClass: 'stock',
        exchange: 'NYSE',
        last: 10,
        lastAt: null,
        days: [],
      },
      '2026-10-06',
    );
    const full = { ...row, marketCap: 1e9, pe: 12.5 };
    const back = fromScreenTuple(toScreenTuple(full));
    expect(back.marketCap).toBe(1e9);
    expect(back.pe).toBe(12.5);
    const old: ScreenRowTuple = toScreenTuple(row).slice(0, 4 + 20 + 2);
    expect(fromScreenTuple(old).marketCap).toBeNull();
    expect(fromScreenTuple(old).instrumentId).toBeNull();
  });
});
