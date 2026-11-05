import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import {
  getNotificationPrefs,
  listNotifications,
  notify,
  parseNotificationPrefs,
  updateNotificationPrefs,
} from '../src/notifications';
import { provisionWorkspace } from '../src/provision';
import { users } from '../src/schema';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
let userA: string;
let userB: string;

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: email.split('@')[0] ?? email, email })
    .returning({ id: users.id });
  if (!row) throw new Error('user insert failed');
  await provisionWorkspace(t.app.db, { userId: row.id, displayName: 'Test' });
  return row.id;
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('notify-a@example.test');
  userB = await createUser('notify-b@example.test');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('notification preferences', () => {
  it('ignores unknown kinds and never mutes the ones that stop trading', () => {
    expect(parseNotificationPrefs(null)).toEqual({ muted: [] });
    expect(parseNotificationPrefs({ muted: 'filled' })).toEqual({ muted: [] });
    expect(
      parseNotificationPrefs({
        muted: ['filled', 'risk_pause', 'disconnect', 'nope', 'triggered'],
      }),
    ).toEqual({ muted: ['triggered', 'filled'] });
  });

  it('saves the muted kinds and skips them, while locked kinds still arrive', async () => {
    expect(await as(userA, getNotificationPrefs)).toEqual({ muted: [] });
    const saved = await as(userA, (tx) =>
      updateNotificationPrefs(tx, {
        userId: userA,
        muted: ['filled', 'reconciliation_mismatch'],
      }),
    );
    expect(saved).toEqual({ muted: ['filled'] });

    for (const userId of [userA, userB]) {
      await as(userId, async (tx) => {
        await notify(tx, { userId, kind: 'filled', title: 'Bought 10 ZTSTA' });
        await notify(tx, { userId, kind: 'risk_pause', title: 'Paused for safety' });
        await notify(tx, { userId, kind: 'strategy_started', title: 'Started' });
      });
    }
    const titles = async (userId: string) =>
      (await as(userId, (tx) => listNotifications(tx))).notifications.map((n) => n.title).sort();
    expect(await titles(userA)).toEqual(['Paused for safety', 'Started']);
    // Another person's preferences are their own.
    expect(await titles(userB)).toEqual(['Bought 10 ZTSTA', 'Paused for safety', 'Started']);

    // Unmuting brings the kind back.
    await as(userA, (tx) => updateNotificationPrefs(tx, { userId: userA, muted: [] }));
    await as(userA, (tx) => notify(tx, { userId: userA, kind: 'filled', title: 'Sold 10 ZTSTA' }));
    expect(await titles(userA)).toContain('Sold 10 ZTSTA');
  });
});
