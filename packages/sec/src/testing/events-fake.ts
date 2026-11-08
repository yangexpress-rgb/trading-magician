import { nyDate, tradingDays } from '@tm/domain';
import type {
  SecCompanyFacts,
  SecFact,
  SecSearchHit,
  SecSubmissions,
  SecTickerFile,
} from '../types';

/**
 * A local stand-in for the EDGAR filings the event jobs read (free data
 * feeds brief v1, ADR 0058): three made-up companies with the same paths and
 * JSON shapes as EDGAR. XYZ reports each quarter with an 8-K Item 2.02 and a
 * 10-Q (its fourth quarter only inside the 10-K's year), with the quarterly
 * EPS of the brief's §7.1 fixture. TGT agrees to be bought for $50.00 a share
 * in cash (8-K Item 1.01), files a merger proxy and later completes the
 * merger; LOWC's agreement gives no price. Refuses requests whose
 * User-Agent names no email, as the SEC does.
 */

export const FAKE_EVENTS_WWW_URL = 'http://www.events-sec.test';
export const FAKE_EVENTS_DATA_URL = 'http://data.events-sec.test';
export const FAKE_EVENTS_EFTS_URL = 'http://efts.events-sec.test';

export const FAKE_XYZ = { cik: 9_910_001, ticker: 'XYZ', name: 'XYZ Corp' };
export const FAKE_TGT = { cik: 9_910_002, ticker: 'TGT', name: 'Target Widgets Inc.' };
export const FAKE_LOWC = { cik: 9_910_003, ticker: 'LOWC', name: 'Lowconf Holdings Inc.' };
/** TGT's buyer, which files the same merger agreement the same day (N152). */
export const FAKE_ACQ = { cik: 9_910_004, ticker: 'ACQH', name: 'Acquirer Holdings Inc.' };
const COMPANIES = [FAKE_XYZ, FAKE_TGT, FAKE_LOWC, FAKE_ACQ];

/** XYZ's quarter ends and diluted EPS: §7.1's 13 quarters, with earlier history before them. */
export const FAKE_XYZ_QUARTERS: readonly { end: string; eps: number }[] = [
  ['2021-03-31', 1.5],
  ['2021-06-30', 1.52],
  ['2021-09-30', 1.55],
  ['2021-12-31', 1.6],
  ['2022-03-31', 1.62],
  ['2022-06-30', 1.66],
  ['2022-09-30', 1.7],
  ['2022-12-31', 1.75],
  ['2023-03-31', 1.8],
  ['2023-06-30', 1.82],
  ['2023-09-30', 1.85],
  ['2023-12-31', 1.85],
  ['2024-03-31', 1.85],
  ['2024-06-30', 1.85],
  ['2024-09-30', 1.95],
  ['2024-12-31', 1.95],
  ['2025-03-31', 1.95],
  ['2025-06-30', 1.95],
  ['2025-09-30', 2.25],
  ['2025-12-31', 2.25],
  ['2026-03-31', 2.25],
  ['2026-06-30', 2.25],
  ['2026-09-30', 2.5],
].map(([end, eps]) => ({ end: end as string, eps: eps as number }));

/** The first Monday at least 33 days after a quarter end: XYZ's release day. */
export function fakeReleaseDay(quarterEnd: string): string {
  const from = new Date(Date.parse(`${quarterEnd}T12:00:00Z`) + 33 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return tradingDays(from, '2030-12-31').find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1)!;
}

export const FAKE_TGT_DEAL = {
  announced: '2025-03-03',
  proxy: '2025-04-15',
  closed: '2025-06-02',
  offer: 50,
} as const;
export const FAKE_LOWC_DEAL = { announced: '2025-06-02' } as const;

const pad = (cik: number) => String(cik).padStart(10, '0');
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface FakeFiling {
  accession: string;
  form: string;
  date: string;
  /** New York wall time, written with a Z as EDGAR does. */
  time: string;
  items: string;
  doc: string;
  body?: string;
}

const MERGER_8K = (
  offer: string,
) => `<html><body><p>Item 1.01 Entry into a Material Definitive Agreement.</p>
<p>On March 2, 2025, Target Widgets Inc., a Delaware corporation (the &#8220;Company&#8221;), entered into an Agreement and Plan of Merger (the &#8220;Merger Agreement&#8221;) with Acquirer Holdings Inc., a Delaware corporation (&#8220;Parent&#8221;), and Widget Merger Sub, Inc. (&#8220;Merger Sub&#8221;). Merger Sub will merge with and into the Company, with the Company continuing as the surviving corporation and a wholly owned subsidiary of Parent.</p>
<p>${offer}</p></body></html>`;

export class FakeEdgarEvents {
  readonly requests: string[] = [];
  constructor(private readonly options: { now: () => Date }) {}

  private today() {
    return nyDate(this.options.now());
  }

  private filings(cik: number): FakeFiling[] {
    const today = this.today();
    const out: FakeFiling[] = [];
    if (cik === FAKE_XYZ.cik) {
      FAKE_XYZ_QUARTERS.forEach((q, i) => {
        const day = fakeReleaseDay(q.end);
        const n = String(i).padStart(4, '0');
        out.push({
          accession: `0009910001-${day.slice(2, 4)}-1${n}`,
          form: '8-K',
          date: day,
          time: '16:05:00',
          items: '2.02,9.01',
          doc: `xyz-8k-${day}.htm`,
        });
        out.push({
          accession: `0009910001-${day.slice(2, 4)}-2${n}`,
          form: q.end.endsWith('12-31') ? '10-K' : '10-Q',
          date: day,
          time: '16:10:00',
          items: '',
          doc: `xyz-${q.end}.htm`,
        });
      });
    }
    if (cik === FAKE_TGT.cik) {
      const d = FAKE_TGT_DEAL;
      out.push(
        {
          accession: '0009910002-25-000101',
          form: '8-K',
          date: d.announced,
          time: '07:30:00',
          items: '1.01,9.01',
          doc: 'tgt-8k-merger.htm',
          body: MERGER_8K(
            `Each share of the Company&#8217;s common stock will be converted into the right to receive $${d.offer.toFixed(2)} in cash, without interest.`,
          ),
        },
        {
          accession: '0009910002-25-000140',
          form: 'DEFM14A',
          date: d.proxy,
          time: '08:00:00',
          items: '',
          doc: 'tgt-defm14a.htm',
        },
        {
          accession: '0009910002-25-000190',
          form: '8-K',
          date: d.closed,
          time: '16:30:00',
          items: '1.02,2.01,3.01,5.01',
          doc: 'tgt-8k-closing.htm',
        },
      );
    }
    if (cik === FAKE_ACQ.cik) {
      // The acquirer's own 8-K for TGT's deal: one deal, two filings (N152).
      out.push({
        accession: '0009910004-25-000301',
        form: '8-K',
        date: FAKE_TGT_DEAL.announced,
        time: '08:15:00',
        items: '1.01',
        doc: 'acqh-8k-merger.htm',
        body: `<html><body><p>Item 1.01 Entry into a Material Definitive Agreement.</p>
<p>On March 2, 2025, Acquirer Holdings Inc. entered into an Agreement and Plan of Merger (the &#8220;Merger Agreement&#8221;) with Target Widgets and Widget Merger Sub, Inc. (&#8220;Merger Sub&#8221;). Merger Sub will merge with and into Target Widgets, with Target Widgets surviving as a wholly owned subsidiary.</p>
<p>Each share of Target Widgets common stock will be converted into the right to receive $${FAKE_TGT_DEAL.offer.toFixed(2)} in cash.</p></body></html>`,
      });
    }
    if (cik === FAKE_LOWC.cik) {
      out.push({
        accession: '0009910003-25-000201',
        form: '8-K',
        date: FAKE_LOWC_DEAL.announced,
        time: '08:00:00',
        items: '1.01',
        doc: 'lowc-8k-merger.htm',
        body: MERGER_8K(
          'The consideration payable to holders of the Company&#8217;s shares is described in the Merger Agreement.',
        ).replace(/Target Widgets Inc\./g, 'Lowconf Holdings Inc.'),
      });
    }
    return out.filter((f) => f.date <= today).sort((a, b) => b.date.localeCompare(a.date));
  }

  private submissions(c: (typeof COMPANIES)[number]): SecSubmissions {
    const f = this.filings(c.cik);
    return {
      cik: pad(c.cik),
      entityType: 'operating',
      sic: '3990',
      sicDescription: null,
      name: c.name,
      tickers: [c.ticker],
      exchanges: ['NYSE'],
      website: null,
      investorWebsite: null,
      category: null,
      fiscalYearEnd: '1231',
      stateOfIncorporation: 'DE',
      stateOfIncorporationDescription: 'DE',
      addresses: {},
      phone: null,
      formerNames: [],
      filings: {
        recent: {
          accessionNumber: f.map((x) => x.accession),
          filingDate: f.map((x) => x.date),
          reportDate: f.map((x) => x.date),
          form: f.map((x) => x.form),
          primaryDocument: f.map((x) => x.doc),
          primaryDocDescription: f.map((x) => x.form),
          acceptanceDateTime: f.map((x) => `${x.date}T${x.time}.000Z`),
          items: f.map((x) => x.items),
        },
        files: [],
      },
    };
  }

  private facts(): SecCompanyFacts {
    const today = this.today();
    const values: SecFact[] = [];
    const quarters = FAKE_XYZ_QUARTERS;
    quarters.forEach((q, i) => {
      const filed = fakeReleaseDay(q.end);
      if (filed > today) return;
      const start = new Date(Date.parse(q.end) - 90 * 86_400_000).toISOString().slice(0, 10);
      const fact = (s: string, val: number, form: string): SecFact => ({
        start: s,
        end: q.end,
        val,
        accn: `xyz-${q.end}`,
        fy: Number(q.end.slice(0, 4)),
        fp: form === '10-K' ? 'FY' : 'Q',
        form,
        filed,
      });
      if (!q.end.endsWith('12-31')) values.push(fact(start, q.eps, '10-Q'));
      else {
        // The 10-K gives the year; the fourth quarter is the year less its three quarters.
        const year = quarters.slice(Math.max(0, i - 3), i + 1);
        const total = Math.round(year.reduce((s, x) => s + x.eps, 0) * 100) / 100;
        values.push(fact(`${q.end.slice(0, 4)}-01-01`, total, '10-K'));
      }
    });
    return {
      cik: FAKE_XYZ.cik,
      entityName: FAKE_XYZ.name,
      facts: {
        'us-gaap': {
          EarningsPerShareDiluted: {
            label: 'Earnings Per Share, Diluted',
            description: null,
            units: { 'USD/shares': values },
          },
        },
      },
    };
  }

  private search(u: URL): { hits: { total: { value: number }; hits: SecSearchHit[] } } {
    const from = u.searchParams.get('startdt') ?? '0000';
    const to = u.searchParams.get('enddt') ?? '9999';
    const forms = (u.searchParams.get('forms') ?? '').split(',');
    const phrase = u.searchParams.get('q') ?? '';
    const hits: SecSearchHit[] = [];
    if (phrase.includes('Agreement and Plan of Merger') && forms.includes('8-K'))
      for (const c of [FAKE_TGT, FAKE_LOWC, FAKE_ACQ])
        for (const f of this.filings(c.cik))
          if (f.body && f.date >= from && f.date <= to)
            hits.push({
              _id: `${f.accession}:${f.doc}`,
              _source: {
                ciks: [pad(c.cik)],
                display_names: [`${c.name}  (${c.ticker})  (CIK ${pad(c.cik)})`],
                file_date: f.date,
                form: f.form,
                adsh: f.accession,
                items: f.items.split(','),
                file_type: f.form,
              },
            });
    return { hits: { total: { value: hits.length }, hits } };
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    this.requests.push(`${u.host}${u.pathname}`);
    const agent = new Headers(init.headers).get('user-agent') ?? '';
    if (!/@/.test(agent)) return new Response('<html>refused</html>', { status: 403 });
    const path = u.pathname;
    if (u.origin === FAKE_EVENTS_WWW_URL && path === '/files/company_tickers_exchange.json') {
      const body: SecTickerFile = {
        fields: ['cik', 'name', 'ticker', 'exchange'],
        data: COMPANIES.map((c) => [c.cik, c.name, c.ticker, 'NYSE']),
      };
      return json(200, body);
    }
    if (u.origin === FAKE_EVENTS_EFTS_URL && path === '/LATEST/search-index')
      return json(200, this.search(u));
    if (u.origin === FAKE_EVENTS_WWW_URL && path.startsWith('/Archives/edgar/data/')) {
      const [, , , , cik, , doc] = path.split('/');
      const f = this.filings(Number(cik)).find((x) => x.doc === doc);
      return f
        ? new Response(f.body ?? '<html><body>Filing</body></html>', { status: 200 })
        : json(404, {});
    }
    if (u.origin !== FAKE_EVENTS_DATA_URL) return json(404, {});
    let m = /^\/submissions\/CIK(\d{10})\.json$/.exec(path);
    if (m) {
      const c = COMPANIES.find((x) => pad(x.cik) === m![1]);
      return c ? json(200, this.submissions(c)) : json(404, {});
    }
    m = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(path);
    if (m) return m[1] === pad(FAKE_XYZ.cik) ? json(200, this.facts()) : json(404, {});
    return json(404, {});
  };
}
