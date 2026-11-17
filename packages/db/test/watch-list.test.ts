import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { provisionWorkspace } from '../src/provision';
import { users } from '../src/schema';
import { withTenant } from '../src/tenant';
import {
  addWatchGroup,
  addWatchItem,
  deleteWatchGroup,
  ensureWatchList,
  listWatchList,
  loadWatchQuotes,
  moveWatchItem,
  removeWatchItem,
  renameWatchGroup,
  saveWatchQuotes,
  setWatchGroupCollapsed,
  touchWatchView,
  watchListDemand,
  WatchListError,
} from '../src/watch-list';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function seedUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: 'Watcher', email })
    .returning({ id: users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'W' });
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

describe('watch list (N292)', () => {
  it('starts with indices and stocks once, and keeps each list its owner’s', async () => {
    const a = await seedUser('watch-a@example.test');
    const b = await seedUser('watch-b@example.test');
    const first = await as(a, (tx) => ensureWatchList(tx, a));
    expect(first.started).toBe(true);
    expect(first.groups.map((g) => g.name)).toEqual(['Indices', 'Stocks']);
    expect(first.groups[1]!.items.map((i) => i.symbol)).toEqual(['AAPL', 'TSLA', 'NFLX', 'NKE']);
    expect((await as(a, (tx) => ensureWatchList(tx, a))).started).toBe(false);
    // Another person sees none of it.
    expect(await as(b, listWatchList)).toEqual([]);

    // An emptied list stays empty.
    for (const g of first.groups) await as(a, (tx) => deleteWatchGroup(tx, g.id));
    expect((await as(a, (tx) => ensureWatchList(tx, a))).groups).toEqual([]);
  });

  it('adds, renames, folds, orders and removes', async () => {
    const a = await seedUser('watch-c@example.test');
    await as(a, (tx) => touchWatchView(tx, a, 0));
    const g = await as(a, (tx) => addWatchGroup(tx, a, '  My  tech '));
    await as(a, (tx) => addWatchItem(tx, a, { groupId: g, symbol: 'msft' }));
    await as(a, (tx) => addWatchItem(tx, a, { groupId: g, symbol: 'NVDA', displayName: 'NVIDIA' }));
    // Adding again keeps one row and fills in the name.
    await as(a, (tx) =>
      addWatchItem(tx, a, { groupId: g, symbol: 'MSFT', displayName: 'Microsoft' }),
    );
    await as(a, (tx) => renameWatchGroup(tx, g, 'Tech'));
    await as(a, (tx) => setWatchGroupCollapsed(tx, g, true));
    let [group] = await as(a, listWatchList);
    expect(group).toMatchObject({ name: 'Tech', collapsed: true });
    expect(group!.items.map((i) => [i.symbol, i.displayName])).toEqual([
      ['MSFT', 'Microsoft'],
      ['NVDA', 'NVIDIA'],
    ]);
    await as(a, (tx) => moveWatchItem(tx, group!.items[1]!.id, -1));
    [group] = await as(a, listWatchList);
    expect(group!.items.map((i) => i.symbol)).toEqual(['NVDA', 'MSFT']);
    await as(a, (tx) => removeWatchItem(tx, group!.items[0]!.id));
    [group] = await as(a, listWatchList);
    expect(group!.items.map((i) => i.symbol)).toEqual(['MSFT']);

    await expect(
      as(a, (tx) => addWatchItem(tx, a, { groupId: g, symbol: '1BAD' })),
    ).rejects.toThrow(WatchListError);
    await expect(as(a, (tx) => addWatchGroup(tx, a, '   '))).rejects.toThrow(WatchListError);
  });

  it('tells the worker which symbols are on open lists, and serves the prices it saves', async () => {
    const a = await seedUser('watch-d@example.test');
    await as(a, (tx) => ensureWatchList(tx, a));
    const demand = await watchListDemand(t.worker.db, 30);
    expect(
      demand
        .filter((d) => d.userId === a)
        .map((d) => d.symbol)
        .sort(),
    ).toEqual(['AAPL', 'DIA', 'IWM', 'NFLX', 'NKE', 'QQQ', 'SPY', 'TSLA', 'VIX']);
    await t.ownerSql`update watch_list_view set viewed_at = now() - interval '5 minutes' where user_id = ${a}`;
    expect((await watchListDemand(t.worker.db, 30)).some((d) => d.userId === a)).toBe(false);

    await saveWatchQuotes(t.worker.db, [
      {
        symbol: 'AAPL',
        last: 351.95,
        prevClose: 352.78,
        priceAt: new Date('2026-11-17T15:00:00Z'),
        daily: false,
        source: 'alpaca-iex',
      },
    ]);
    const [q] = await as(a, (tx) => loadWatchQuotes(tx, ['AAPL', 'TSLA']));
    expect(q).toMatchObject({ symbol: 'AAPL', last: 351.95, prevClose: 352.78, daily: false });
    // The app login reads prices but never writes them.
    await expect(
      as(a, (tx) =>
        saveWatchQuotes(tx, [
          { symbol: 'TSLA', last: 1, prevClose: 1, priceAt: new Date(), daily: false, source: 'x' },
        ]),
      ),
    ).rejects.toThrow();
  });
});
