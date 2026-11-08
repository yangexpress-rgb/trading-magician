import { describe, expect, it } from 'vitest';
import { fetchCalendar, finnhubCalendar, fmpCalendar, type Fetch } from './calendar';
import { eveningDue } from './loop';

/** The forward earnings calendar (free data feeds brief v1 §5.1, §9). */

const respond =
  (status: number, body: unknown, seen: string[] = []): Fetch =>
  async (url) => {
    seen.push(url);
    return new Response(JSON.stringify(body), { status });
  };

describe('earnings calendar sources', () => {
  it('reads FMP free in range windows, one call per window, never per symbol', async () => {
    const seen: string[] = [];
    const fmp = fmpCalendar({
      apiKey: 'fmp-test-key',
      fetch: respond(
        200,
        [
          { symbol: 'AAPL', date: '2027-01-28', epsEstimated: 2.35, time: 'amc' },
          { symbol: 'BRK-B', date: '2027-02-21', epsEstimated: null },
          { symbol: '', date: 'soon' },
        ],
        seen,
      ),
    });
    const got = await fetchCalendar([fmp], '2026-11-09');
    expect(seen).toHaveLength(3);
    expect(seen[0]).toContain('/stable/earnings-calendar?from=2026-11-09&to=2026-12-08');
    expect(got.provider).toBe('fmp');
    expect(got.rows).toContainEqual({
      symbol: 'AAPL',
      date: '2027-01-28',
      timeHint: 'amc',
      estimatedEps: 2.35,
    });
    expect(got.rows.find((r) => r.symbol === 'BRK.B')?.estimatedEps).toBeNull();
    expect(got.rows.some((r) => r.symbol === '')).toBe(false);
  });

  it('falls back to Finnhub when FMP fails, and never echoes the key', async () => {
    const fmp = fmpCalendar({ apiKey: 'secret-fmp-key', fetch: respond(429, {}) });
    const finnhub = finnhubCalendar({
      apiKey: 'secret-finnhub-key',
      fetch: respond(200, {
        earningsCalendar: [{ symbol: 'MSFT', date: '2027-01-27', epsEstimate: 3.1, hour: 'amc' }],
      }),
    });
    const got = await fetchCalendar([fmp, finnhub], '2026-11-09');
    expect(got.provider).toBe('finnhub');
    expect(got.rows[0]).toMatchObject({ symbol: 'MSFT', estimatedEps: 3.1 });
    await expect(fetchCalendar([fmp], '2026-11-09')).rejects.toThrow(
      'FMP is over its free-tier limit',
    );
    const refused = fmpCalendar({ apiKey: 'secret-fmp-key', fetch: respond(401, {}) });
    const e = await fetchCalendar([refused], '2026-11-09').catch((x: Error) => x);
    expect(String(e)).not.toContain('secret');
  });

  it('without a source, says so (EDGAR-only mode)', async () => {
    await expect(fetchCalendar([], '2026-11-09')).rejects.toThrow(/No earnings calendar/);
  });
});

describe('the evening jobs', () => {
  it('start at 18:30 New York', () => {
    expect(eveningDue(new Date('2026-11-09T23:29:00Z'))).toBe(false);
    expect(eveningDue(new Date('2026-11-09T23:30:00Z'))).toBe(true);
  });
});
