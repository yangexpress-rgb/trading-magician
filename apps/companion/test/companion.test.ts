import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCompanion } from '../src/companion';
import { newConfig, type CompanionConfig } from '../src/config';
import { startLocalStore } from '../src/store';
import { jobStates } from '../src/sync';

/**
 * The companion core end to end (ADR 0116, S2 step 2): a real local Postgres
 * with the Research Store tables, a hello, and the reference pull, against a
 * stand-in for the cloud API. Postgres refuses to run as root, so the test
 * is skipped there (CI runners and people's computers are not root).
 */

const isRoot = process.getuid?.() === 0;
const port = 55_000 + Math.floor(Math.random() * 5_000);

let dir: string;
let home: string;
let config: CompanionConfig;
const calls: string[] = [];
let revoked = false;

const instruments = Array.from({ length: 3 }, (_, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`,
  symbol: ['AAPL', 'MSFT', 'SPY'][i]!,
  assetClass: 'equity',
  kind: i === 2 ? 'etf' : 'stock',
  displayName: ['Apple', 'Microsoft', 'SPDR S&P 500'][i]!,
  venue: 'XNAS',
  currency: 'USD',
}));

const cloud = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
  if ((init?.headers as Record<string, string>).authorization !== 'Bearer tma_test') {
    return Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 });
  }
  if (revoked) {
    return Response.json(
      { error: { code: 'connection_revoked', message: 'This companion was unpaired.' } },
      { status: 401 },
    );
  }
  if (url.pathname.endsWith('/hello')) {
    return Response.json({
      connectionId: 'c1',
      seenAt: new Date().toISOString(),
      serverTime: 'now',
    });
  }
  if (url.pathname.endsWith('/instruments')) {
    const after = url.searchParams.get('after');
    return after
      ? Response.json({ instruments: instruments.slice(2), next: null })
      : Response.json({ instruments: instruments.slice(0, 2), next: instruments[1]!.id });
  }
  if (url.pathname.endsWith('/membership')) {
    return Response.json({
      periods: [
        {
          groupId: 'sp500',
          symbol: 'AAPL',
          instrumentId: instruments[0]!.id,
          fromDate: '1982-11-30',
          toDate: null,
        },
        {
          groupId: 'sp500',
          symbol: 'XYZ',
          instrumentId: null,
          fromDate: '2001-01-02',
          toDate: '2010-06-30',
        },
      ],
    });
  }
  if (url.pathname.endsWith('/ml/state')) return Response.json({ models: [], runs: [] });
  if (url.pathname.endsWith('/pushes')) return Response.json({ pushes: [] });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

/** Runs one round of jobs, then stops. */
const oneRound = (log: string[] = []) => {
  const controller = new AbortController();
  return runCompanion({
    home,
    config,
    signal: controller.signal,
    log: (l) => log.push(l),
    fetch: cloud,
    trainer: async () => ({ code: 0, tail: [] }),
    hooks: { sleep: async () => controller.abort() },
  });
};

describe.skipIf(isRoot)('Local Companion core (ADR 0116)', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm-companion-'));
    await chmod(dir, 0o700);
    home = join(dir, 'home');
    config = {
      ...newConfig({ apiBase: 'https://tm.example', token: 'tma_test' }, null),
      pgPort: port,
    };
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('creates the local Research Store, says hello and pulls reference data', async () => {
    expect(await oneRound()).toEqual({ kind: 'aborted' });
    expect(calls).toEqual([
      'POST /api/companion/v1/hello',
      'GET /api/companion/v1/instruments',
      `GET /api/companion/v1/instruments?after=${instruments[1]!.id}`,
      'GET /api/companion/v1/membership',
      // The feature writer, then the trainer, each mirror the registry first (no models here).
      'GET /api/companion/v1/ml/state',
      'GET /api/companion/v1/ml/state',
      'GET /api/companion/v1/pushes?open=1',
    ]);
    const store = await startLocalStore({ home, port, password: config.pgPassword });
    try {
      const tables = await store.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public' order by 1`;
      expect(tables.map((t) => t.table_name)).toEqual(
        expect.arrayContaining([
          'backtest_trade',
          'factor_snapshot',
          'ml_feature_snapshot',
          'pattern_occurrence',
        ]),
      );
      const syms = await store.sql<
        { symbol: string }[]
      >`select symbol from companion.instrument order by symbol`;
      expect(syms.map((s) => s.symbol)).toEqual(['AAPL', 'MSFT', 'SPY']);
      const periods = await store.sql<{ symbol: string; to_date: string | null }[]>`
        select symbol, to_date::text from companion.membership_period order by symbol`;
      expect(periods).toEqual([
        { symbol: 'AAPL', to_date: null },
        { symbol: 'XYZ', to_date: '2010-06-30' },
      ]);
      const states = await jobStates(store.sql);
      expect(states.map((s) => [s.job, s.error])).toEqual([
        ['features', null],
        ['hello', null],
        ['ml', null],
        ['reference', null],
      ]);
      expect(states[3]!.detail).toEqual({ instruments: 3, periods: 2 });
    } finally {
      await store.stop();
    }
  });

  it('keeps its data across restarts and replaces reference data wholesale', async () => {
    instruments.pop();
    await oneRound();
    const store = await startLocalStore({ home, port, password: config.pgPassword });
    try {
      const [row] = await store.sql<
        { n: number }[]
      >`select count(*)::int as n from companion.instrument`;
      expect(row!.n).toBe(2);
    } finally {
      await store.stop();
    }
  });

  it('stops and says so when the pairing is removed', async () => {
    revoked = true;
    const log: string[] = [];
    expect(await oneRound(log)).toEqual({
      kind: 'unpaired',
      message: 'This companion was unpaired.',
    });
    const store = await startLocalStore({ home, port, password: config.pgPassword });
    try {
      const states = await jobStates(store.sql);
      expect(states.find((s) => s.job === 'hello')!.error).toBe('This companion was unpaired.');
    } finally {
      await store.stop();
    }
  });
});
