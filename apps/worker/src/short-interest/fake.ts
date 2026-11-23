import type { Fetch } from './finra';

/**
 * An in-process stand-in for FINRA's token endpoint and Query API (N323), for
 * tests and SHORT_INTEREST_FAKE: one client credential, rows per settlement
 * date in FINRA's JSON shape, pages of `pageSize`, and a log of requests.
 */

export const FAKE_FINRA_API_URL = 'https://finra.fake.test';
export const FAKE_FINRA_TOKEN_URL = 'https://finra-token.fake.test/oauth2/access_token';
export const FAKE_FINRA_ID = 'fake-client';
export const FAKE_FINRA_SECRET = 'fake-secret';

export type FinraJsonRow = Record<string, unknown>;

export class FakeFinra {
  readonly requests: string[] = [];
  /** Rows per settlement date, in FINRA's JSON shape. */
  readonly settlements = new Map<string, FinraJsonRow[]>();
  pageSize = 5000;
  tokensIssued = 0;

  add(rows: FinraJsonRow[]) {
    for (const r of rows) {
      const d = String(r.settlementDate);
      const list = this.settlements.get(d) ?? [];
      const i = list.findIndex((x) => x.symbolCode === r.symbolCode);
      if (i >= 0) list[i] = r;
      else list.push(r);
      this.settlements.set(d, list);
    }
  }

  readonly fetch: Fetch = async (url, init) => {
    const u = new URL(url);
    this.requests.push(`${init.method ?? 'GET'} ${u.pathname}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.startsWith(FAKE_FINRA_TOKEN_URL)) {
      const auth = new Headers(init.headers).get('authorization') ?? '';
      const ok = `Basic ${Buffer.from(`${FAKE_FINRA_ID}:${FAKE_FINRA_SECRET}`).toString('base64')}`;
      if (auth !== ok) return json({ error: 'invalid_client' }, 401);
      this.tokensIssued++;
      return json({ access_token: `tok${this.tokensIssued}`, expires_in: 1800 });
    }
    if (!url.startsWith(FAKE_FINRA_API_URL)) return new Response('not found', { status: 404 });
    const auth = new Headers(init.headers).get('authorization') ?? '';
    if (!/^Bearer tok\d+$/.test(auth)) return json({ message: 'unauthorized' }, 401);
    if (u.pathname === '/partitions/group/otcMarket/name/consolidatedShortInterest') {
      return json({
        datasetGroup: 'OTCMARKET',
        datasetName: 'CONSOLIDATEDSHORTINTEREST',
        partitionFields: ['settlementDate'],
        availablePartitions: [...this.settlements.keys()].sort().map((d) => ({ partitions: [d] })),
      });
    }
    if (u.pathname === '/data/group/otcMarket/name/consolidatedShortInterest') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        limit?: number;
        offset?: number;
        compareFilters?: { fieldName: string; fieldValue: string }[];
      };
      const date = body.compareFilters?.find((f) => f.fieldName === 'settlementDate')?.fieldValue;
      const rows = this.settlements.get(date ?? '') ?? [];
      const limit = Math.min(body.limit ?? this.pageSize, this.pageSize);
      const page = rows.slice(body.offset ?? 0, (body.offset ?? 0) + limit);
      if (page.length === 0) return new Response(null, { status: 204 });
      return json(page);
    }
    return json({ message: 'not found' }, 404);
  };
}

/** A FINRA row in the API's JSON shape. */
export function finraRow(
  symbol: string,
  settlementDate: string,
  current: number,
  previous: number,
  avgDailyVolume = 1_000_000,
  extra: FinraJsonRow = {},
): FinraJsonRow {
  return {
    accountingYearMonthNumber: Number(settlementDate.replace(/-/g, '')),
    averageDailyVolumeQuantity: avgDailyVolume,
    changePercent: previous > 0 ? Math.round(((current - previous) / previous) * 10000) / 100 : 100,
    changePreviousNumber: current - previous,
    currentShortPositionQuantity: current,
    daysToCoverQuantity:
      avgDailyVolume > 0 ? Math.round((current / avgDailyVolume) * 100) / 100 : 999.99,
    issueName: `${symbol} Inc.`,
    issuerServicesGroupExchangeCode: 'R',
    marketClassCode: 'NNM',
    previousShortPositionQuantity: previous,
    revisionFlag: null,
    settlementDate,
    stockSplitFlag: null,
    symbolCode: symbol,
    ...extra,
  };
}
