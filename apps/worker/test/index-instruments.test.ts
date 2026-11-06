import {
  createFeed,
  eq,
  getInstrumentLookup,
  getPriceChart,
  listRoutes,
  provisionWorkspace,
  requestInstrumentLookup,
  requestPriceChart,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cboeProvider } from '../src/cboe';
import { fakeCboeFetch } from '../src/cboe-fake';
import { runInstrumentLookups } from '../src/instrument-lookups';
import { runPriceCharts } from '../src/price-charts';
import type { ProviderRegistry } from '../src/providers';

/**
 * Indicator-only instruments (Design v1.2 item 5): the VIX is found by search
 * without a stock feed, registered as an index that can't be traded, and
 * charted from the CBOE feed, which is routed for daily bars only.
 */

let t: TestDatabase;
let user: string;
const quiet = { info: () => undefined, warn: () => undefined };
const NOW = new Date('2026-10-06T15:00:00Z');
const providers: ProviderRegistry = { cboe: cboeProvider({ fetch: fakeCboeFetch(() => NOW) }) };
const opts = { providers, privateKey: undefined, logger: quiet, now: () => NOW };
const as = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId: user }, fn);

beforeAll(async () => {
  t = await createTestDatabase();
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Index', email: 'index@example.test' })
    .returning({ id: schema.users.id });
  user = row!.id;
  await provisionWorkspace(t.app.db, { userId: user, displayName: 'Index' });
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('the VIX, watched but never traded', () => {
  let vix: string;

  it('routes a CBOE feed for index bars only, with no key', async () => {
    await as((tx) =>
      createFeed(tx, {
        userId: user,
        name: 'CBOE index history',
        provider: 'cboe',
        assetClasses: ['index'],
      }),
    );
    const routes = (await as((tx) => listRoutes(tx))).filter((r) => r.assetClass === 'index');
    expect(routes.map((r) => r.dataType)).toEqual(['bars']);
  });

  it('finds "VIX" as an indicator-only index, not a VIX-futures ETF', async () => {
    const started = await as((tx) => requestInstrumentLookup(tx, { userId: user, symbol: 'VIX' }));
    await runInstrumentLookups({ db: t.worker.db, ...opts });
    const found = await as((tx) => getInstrumentLookup(tx, started.id));
    expect(found).toMatchObject({
      status: 'found',
      instrument: {
        symbol: 'VIX',
        assetClass: 'index',
        venue: 'CBOE',
        kind: 'indicator_only',
        displayName: 'CBOE Volatility Index',
      },
    });
    vix = found.instrument!.id;
  });

  it('charts five years of daily VIX bars from CBOE', async () => {
    const started = await as((tx) =>
      requestPriceChart(tx, {
        userId: user,
        instrumentId: vix,
        range: '5y',
        interval: '1d',
        now: NOW,
      }),
    );
    await runPriceCharts({ db: t.worker.db, ...opts });
    const c = await as((tx) => getPriceChart(tx, started.id));
    expect(c).toMatchObject({ status: 'ready', source: 'CBOE index history' });
    expect(c.bars!.length).toBeGreaterThan(1200);
  });

  it('says why there are no intraday VIX bars', async () => {
    const started = await as((tx) =>
      requestPriceChart(tx, {
        userId: user,
        instrumentId: vix,
        range: '1w',
        interval: '1h',
        now: NOW,
      }),
    );
    await runPriceCharts({ db: t.worker.db, ...opts });
    const c = await as((tx) => getPriceChart(tx, started.id));
    expect(c.status).toBe('failed');
    expect(c.message).toMatch(/daily bars only/);
  });

  it('keeps every index indicator-only in the database', async () => {
    await expect(
      t.owner.db
        .update(schema.instruments)
        .set({ kind: 'tradable' })
        .where(eq(schema.instruments.id, vix)),
    ).rejects.toMatchObject({ cause: { constraint_name: 'instrument_index_kind' } });
  });
});
