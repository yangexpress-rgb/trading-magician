import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortInterestPublicationDate } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { loadWorkerEnv, shortInterestMode } from './env';
import {
  FAKE_FINRA_API_URL,
  FAKE_FINRA_ID,
  FAKE_FINRA_SECRET,
  FAKE_FINRA_TOKEN_URL,
  FakeFinra,
  finraRow,
} from './short-interest/fake';
import { finraClient, parseFinraRow } from './short-interest/finra';
import { availableDateFor } from './short-interest/job';

/** FINRA short interest without a database (N323): the credential gate, the client, the schedule. */

const FIX = join(__dirname, '..', 'test', 'fixtures', 'finra');

describe('B1: the credential gate', () => {
  it('idles without both credentials, and a bad value never fails the boot', () => {
    expect(shortInterestMode(loadWorkerEnv({}))).toBe('not_configured');
    expect(shortInterestMode(loadWorkerEnv({ FINRA_CLIENT_ID: 'x' }))).toBe('not_configured');
    expect(
      shortInterestMode(loadWorkerEnv({ FINRA_CLIENT_ID: ' ', FINRA_CLIENT_SECRET: ' ' })),
    ).toBe('not_configured');
    // Any text loads: FINRA refusing it is the job's log line, not a boot failure.
    const odd = loadWorkerEnv({ FINRA_CLIENT_ID: '?', FINRA_CLIENT_SECRET: '!' });
    expect(shortInterestMode(odd)).toBe('on');
    expect(
      shortInterestMode(
        loadWorkerEnv({
          FINRA_CLIENT_ID: 'a',
          FINRA_CLIENT_SECRET: 'b',
          SHORT_INTEREST_ENABLED: 'off',
        }),
      ),
    ).toBe('off');
  });
});

describe('the publication date', () => {
  it("matches every date of FINRA's published 2026–2027 schedule", () => {
    const { schedule } = JSON.parse(
      readFileSync(join(FIX, 'publication-schedule.json'), 'utf8'),
    ) as { schedule: [string, string][] };
    expect(schedule.length).toBe(28);
    for (const [settlement, published] of schedule)
      expect(shortInterestPublicationDate(settlement), settlement).toBe(published);
  });

  it('uses the day the job first saw a recent settlement when FINRA published late', () => {
    expect(availableDateFor('2026-10-30', '2026-11-10')).toBe('2026-11-10');
    expect(availableDateFor('2026-10-30', '2026-11-12')).toBe('2026-11-12');
    // On or before the schedule date: the schedule date.
    expect(availableDateFor('2026-10-30', '2026-11-09')).toBe('2026-11-10');
    // A backfill of old settlements keeps the schedule date.
    expect(availableDateFor('2018-01-12', '2026-11-23')).toBe(
      shortInterestPublicationDate('2018-01-12'),
    );
  });
});

describe('the FINRA client', () => {
  const client = (fake: FakeFinra, secret = FAKE_FINRA_SECRET) =>
    finraClient({
      pageSize: fake.pageSize,
      clientId: FAKE_FINRA_ID,
      clientSecret: secret,
      apiUrl: FAKE_FINRA_API_URL,
      tokenUrl: FAKE_FINRA_TOKEN_URL,
      fetch: fake.fetch,
    });

  it('reads partitions and pages through a settlement with one token', async () => {
    const fake = new FakeFinra();
    fake.pageSize = 2;
    fake.add([1, 2, 3, 4, 5].map((i) => finraRow(`S${i}`, '2026-10-30', i * 100, 100)));
    fake.add([finraRow('S1', '2026-10-15', 100, 90)]);
    const c = client(fake);
    expect(await c.settlementDates()).toEqual(['2026-10-15', '2026-10-30']);
    const rows = await c.settlement('2026-10-30');
    expect(rows.map((r) => r.symbol)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(fake.tokensIssued).toBe(1);
  });

  it('says the credential was refused without echoing it', async () => {
    const fake = new FakeFinra();
    const err = await client(fake, 'wrong-secret-123')
      .settlementDates()
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('FINRA refused the API credential');
    expect((err as Error).message).not.toContain('wrong-secret');
  });

  it("parses FINRA's own AAPL rows field for field", () => {
    const { rows } = JSON.parse(
      readFileSync(join(FIX, 'aapl-consolidated-short-interest.json'), 'utf8'),
    ) as { rows: Record<string, unknown>[] };
    const last = rows.at(-1)!;
    expect(parseFinraRow(last)).toEqual({
      symbol: 'AAPL',
      settlementDate: '2026-10-30',
      shortShares: 144791472,
      previousShortShares: 131591865,
      changeShares: 13199607,
      avgDailyVolume: 43085075,
      daysToCover: 3.36,
      revisionFlag: null,
    });
    expect(parseFinraRow({ symbolCode: 'X' })).toBeUndefined();
  });
});
