import type {
  SecCompanyConcept,
  SecCompanyFacts,
  SecFact,
  SecFrame,
  SecSubmissions,
  SecTickerFile,
} from '../types';
import conceptFixture from './fixtures/companyconcept.json';
import submissionsFixture from './fixtures/submissions.json';

/**
 * A local stand-in for SEC EDGAR (ADR 0031), for tests and E2E: the same
 * paths and JSON shapes as `fixtures`, for two made-up companies whose
 * tickers match the fake Alpaca's (ZTSTA, ZTSTB). It refuses requests whose
 * User-Agent names no email, as the SEC does.
 */

export const FAKE_SEC_WWW_URL = 'http://sec.test';
export const FAKE_SEC_DATA_URL = 'http://data.sec.test';

interface FakeCompany {
  cik: number;
  ticker: string;
  name: string;
  exchange: string;
  sic: string;
  industry: string;
  city: string;
  state: string;
  /** MMDD */
  fiscalYearEnd: string;
  /** Revenue of the oldest year; later years grow by `growth`. */
  revenue: number;
  growth: number;
  margin: number;
  shares: number;
}

export const FAKE_SEC_COMPANIES: readonly FakeCompany[] = [
  {
    cik: 9_900_001,
    ticker: 'ZTSTA',
    name: 'Test Alpha Inc.',
    exchange: 'Nasdaq',
    sic: '7372',
    industry: 'SERVICES-PREPACKAGED SOFTWARE',
    city: 'SPRINGFIELD',
    state: 'IL',
    fiscalYearEnd: '1231',
    revenue: 1_000_000_000,
    growth: 0.12,
    margin: 0.18,
    shares: 250_000_000,
  },
  {
    cik: 9_900_002,
    ticker: 'ZTSTB',
    name: 'Test Beta Corp.',
    exchange: 'NYSE',
    sic: '2834',
    industry: 'PHARMACEUTICAL PREPARATIONS',
    city: 'RIVERTON',
    state: 'NJ',
    fiscalYearEnd: '0630',
    revenue: 4_000_000_000,
    growth: 0.04,
    margin: 0.09,
    shares: 900_000_000,
  },
];

export interface FakeSecOptions {
  now: () => Date;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const pad = (cik: number) => String(cik).padStart(10, '0');
const iso = (y: number, mmdd: string) => `${y}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface FakeYear {
  start: string;
  end: string;
  filed: string;
  accn: string;
  fy: number;
  revenue: number;
  netIncome: number;
  eps: number;
  equity: number;
  shares: number;
}

export class FakeSec {
  readonly requests: string[] = [];
  private readonly now: () => Date;

  constructor(options: FakeSecOptions) {
    this.now = options.now;
  }

  /** Five fiscal years, filed 60 days after each ends, up to today. */
  private years(c: FakeCompany): FakeYear[] {
    const today = this.now().toISOString().slice(0, 10);
    const thisYear = this.now().getUTCFullYear();
    const out: FakeYear[] = [];
    for (let y = thisYear - 6; y <= thisYear; y++) {
      const end = iso(y, c.fiscalYearEnd);
      const filed = addDays(end, 60);
      if (filed > today) continue;
      const i = out.length;
      const revenue = Math.round(c.revenue * (1 + c.growth) ** i);
      const netIncome = Math.round(revenue * c.margin);
      out.push({
        start: addDays(iso(y - 1, c.fiscalYearEnd), 1),
        end,
        filed,
        accn: `${pad(c.cik)}-${String(y).slice(2)}-000010`,
        fy: y,
        revenue,
        netIncome,
        eps: Math.round((netIncome / c.shares) * 100) / 100,
        equity: Math.round(revenue * 0.6),
        shares: c.shares,
      });
    }
    return out.slice(-5);
  }

  private facts(c: FakeCompany): SecCompanyFacts {
    const years = this.years(c);
    const duration = (v: (y: FakeYear) => number): SecFact[] =>
      years.map((y) => ({
        start: y.start,
        end: y.end,
        val: v(y),
        accn: y.accn,
        fy: y.fy,
        fp: 'FY',
        form: '10-K',
        filed: y.filed,
      }));
    const instant = (v: (y: FakeYear) => number): SecFact[] =>
      years.map((y) => ({
        end: y.end,
        val: v(y),
        accn: y.accn,
        fy: y.fy,
        fp: 'FY',
        form: '10-K',
        filed: y.filed,
      }));
    const concept = (label: string, unit: string, facts: SecFact[]) => ({
      label,
      description: null,
      units: { [unit]: facts },
    });
    const latest = years.at(-1);
    return {
      cik: c.cik,
      entityName: c.name,
      facts: {
        dei: {
          EntityCommonStockSharesOutstanding: concept(
            'Entity Common Stock, Shares Outstanding',
            'shares',
            latest
              ? [
                  {
                    end: addDays(latest.end, 30),
                    val: c.shares,
                    accn: latest.accn,
                    fy: latest.fy,
                    fp: 'FY',
                    form: '10-K',
                    filed: latest.filed,
                  },
                ]
              : [],
          ),
        },
        'us-gaap': {
          Revenues: concept(
            'Revenues',
            'USD',
            duration((y) => y.revenue),
          ),
          GrossProfit: concept(
            'Gross Profit',
            'USD',
            duration((y) => Math.round(y.revenue * 0.55)),
          ),
          OperatingIncomeLoss: concept(
            'Operating Income (Loss)',
            'USD',
            duration((y) => Math.round(y.netIncome * 1.3)),
          ),
          NetIncomeLoss: concept(
            'Net Income (Loss)',
            'USD',
            duration((y) => y.netIncome),
          ),
          EarningsPerShareDiluted: concept(
            'Earnings Per Share, Diluted',
            'USD/shares',
            duration((y) => y.eps),
          ),
          WeightedAverageNumberOfDilutedSharesOutstanding: concept(
            'Weighted Average Number of Shares Outstanding, Diluted',
            'shares',
            duration((y) => y.shares),
          ),
          NetCashProvidedByUsedInOperatingActivities: concept(
            'Net Cash Provided by (Used in) Operating Activities',
            'USD',
            duration((y) => Math.round(y.netIncome * 1.2)),
          ),
          PaymentsToAcquirePropertyPlantAndEquipment: concept(
            'Payments to Acquire Property, Plant, and Equipment',
            'USD',
            duration((y) => Math.round(y.revenue * 0.05)),
          ),
          Assets: concept(
            'Assets',
            'USD',
            instant((y) => Math.round(y.revenue * 1.5)),
          ),
          Liabilities: concept(
            'Liabilities',
            'USD',
            instant((y) => Math.round(y.revenue * 0.9)),
          ),
          StockholdersEquity: concept(
            "Stockholders' Equity",
            'USD',
            instant((y) => y.equity),
          ),
          CashAndCashEquivalentsAtCarryingValue: concept(
            'Cash and Cash Equivalents',
            'USD',
            instant((y) => Math.round(y.revenue * 0.2)),
          ),
          LongTermDebtNoncurrent: concept(
            'Long-Term Debt, Noncurrent',
            'USD',
            instant((y) => Math.round(y.revenue * 0.3)),
          ),
        },
      },
    };
  }

  private submissions(c: FakeCompany): SecSubmissions {
    const years = this.years(c).reverse();
    const address = {
      ...submissionsFixture.addresses.business,
      street1: '1 TEST PLAZA',
      city: c.city,
      stateOrCountry: c.state,
      stateOrCountryDescription: c.state,
    };
    return {
      ...submissionsFixture,
      cik: pad(c.cik),
      sic: c.sic,
      sicDescription: c.industry,
      name: c.name,
      tickers: [c.ticker],
      exchanges: [c.exchange],
      website: '',
      investorWebsite: '',
      fiscalYearEnd: c.fiscalYearEnd,
      stateOfIncorporation: 'DE',
      stateOfIncorporationDescription: 'DE',
      addresses: { mailing: address, business: address },
      phone: '555-0100',
      formerNames: [],
      filings: {
        recent: {
          ...submissionsFixture.filings.recent,
          accessionNumber: years.map((y) => y.accn),
          filingDate: years.map((y) => y.filed),
          reportDate: years.map((y) => y.end),
          form: years.map(() => '10-K'),
          primaryDocument: years.map(
            (y) => `${c.ticker.toLowerCase()}-${y.end.replace(/-/g, '')}.htm`,
          ),
          primaryDocDescription: years.map(() => '10-K'),
        },
      },
    };
  }

  private frame(tag: string, unit: string, year: number): SecFrame | undefined {
    const pick: Record<string, (y: FakeYear) => number> = {
      Revenues: (y) => y.revenue,
      NetIncomeLoss: (y) => y.netIncome,
      EarningsPerShareDiluted: (y) => y.eps,
      WeightedAverageNumberOfDilutedSharesOutstanding: (y) => y.shares,
    };
    const value = pick[tag];
    if (!value) return undefined;
    const data = FAKE_SEC_COMPANIES.flatMap((c) => {
      // Like the SEC, a fiscal year counts for the calendar year it mostly falls in.
      const y = this.years(c).find(
        (fy) => new Date(Date.parse(fy.end) - 182 * 86_400_000).getUTCFullYear() === year,
      );
      return y
        ? [
            {
              accn: y.accn,
              cik: c.cik,
              entityName: c.name,
              loc: `US-${c.state}`,
              start: y.start,
              end: y.end,
              val: value(y),
            },
          ]
        : [];
    });
    if (data.length === 0) return undefined;
    return {
      taxonomy: 'us-gaap',
      tag,
      ccp: `CY${year}`,
      uom: unit.replace('-per-', '/'),
      label: tag,
      description: null,
      pts: data.length,
      data,
    };
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    this.requests.push(u.pathname);
    const agent = new Headers(init.headers).get('user-agent') ?? '';
    if (!/@/.test(agent)) {
      return new Response(
        '<html>Your request has been identified as part of a network of automated tools…</html>',
        {
          status: 403,
        },
      );
    }
    const byCik = (raw: string | undefined) => FAKE_SEC_COMPANIES.find((c) => pad(c.cik) === raw);
    const path = u.pathname;
    if (u.origin === FAKE_SEC_WWW_URL && path === '/files/company_tickers_exchange.json') {
      const body: SecTickerFile = {
        fields: ['cik', 'name', 'ticker', 'exchange'],
        data: FAKE_SEC_COMPANIES.map((c) => [c.cik, c.name, c.ticker, c.exchange]),
      };
      return json(200, body);
    }
    if (u.origin !== FAKE_SEC_DATA_URL) return json(404, { error: 'not found' });
    let m = /^\/submissions\/CIK(\d{10})\.json$/.exec(path);
    if (m) {
      const c = byCik(m[1]);
      return c ? json(200, this.submissions(c)) : json(404, {});
    }
    m = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(path);
    if (m) {
      const c = byCik(m[1]);
      return c ? json(200, this.facts(c)) : json(404, {});
    }
    m =
      /^\/api\/xbrl\/companyconcept\/CIK(\d{10})\/dei\/EntityCommonStockSharesOutstanding\.json$/.exec(
        path,
      );
    if (m) {
      if (m[1] === '0000320193') return json(200, conceptFixture as SecCompanyConcept);
      const c = byCik(m[1]);
      return c ? json(200, { ...conceptFixture, cik: c.cik, entityName: c.name }) : json(404, {});
    }
    m = /^\/api\/xbrl\/frames\/us-gaap\/([A-Za-z]+)\/([A-Za-z-]+)\/CY(\d{4})\.json$/.exec(path);
    if (m) {
      const frame = this.frame(m[1]!, m[2]!, Number(m[3]));
      return frame ? json(200, frame) : json(404, {});
    }
    return json(404, {});
  };
}
