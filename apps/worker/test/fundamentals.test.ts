import {
  createCredential,
  createFeed,
  generateCredentialKeyPair,
  loadFundamentals,
  provisionWorkspace,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { latestObservation } from '@tm/domain';
import { FAKE_SEC_DATA_URL, FAKE_SEC_WWW_URL, FakeSec } from '@tm/sec/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNDAMENTALS_TTL_MS, fundamentalsLoader, NO_COMPANY_FEED } from '../src/fundamentals';
import { secProvider } from '../src/sec';

/**
 * Point-in-time fundamentals (v1.2 item 6, ADR 0043): synced through the
 * tenant's SEC feed into tables only the worker can read, shared by every
 * tenant, and fetched again once a day.
 */

let t: TestDatabase;
let user: string;
let other: string;
const keys = generateCredentialKeyPair();
let nowMs = Date.parse('2026-10-06T15:00:00Z');
const sec = new FakeSec({ now: () => new Date(nowMs) });
const fundamentals = {
  sec: secProvider({
    fetch: sec.fetch,
    fake: { wwwUrl: FAKE_SEC_WWW_URL, dataUrl: FAKE_SEC_DATA_URL },
    spacingMs: 0,
  }),
};
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const instruments = [
  { id: 'a', symbol: 'ZTSTA' },
  { id: 'b', symbol: 'ZTSTB' },
  { id: 'x', symbol: 'NOPE' },
];

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Filings', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Filings' });
  return row!.id;
}

async function addSecFeed(userId: string) {
  await as(userId, async (tx) => {
    const credential = await createCredential(tx, {
      userId,
      provider: 'sec',
      label: 'SEC EDGAR contact',
      fields: { contactEmail: 'filings@example.test' },
      publicKey: keys.publicKey,
    });
    await createFeed(tx, {
      userId,
      name: 'SEC EDGAR',
      provider: 'sec',
      credentialId: credential.id,
      assetClasses: ['stock'],
    });
  });
}

beforeAll(async () => {
  t = await createTestDatabase();
  user = await createUser('filings-a@example.test');
  other = await createUser('filings-b@example.test');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('point-in-time fundamentals sync', () => {
  const load = () =>
    fundamentalsLoader({
      db: t.worker.db,
      fundamentals,
      privateKey: keys.privateKey,
      now: () => new Date(nowMs),
    });

  it('needs a company data feed', async () => {
    await expect(load()(user, instruments)).rejects.toThrow(NO_COMPANY_FEED);
  });

  it('stores filings from the SEC feed and reads them back point in time', async () => {
    await addSecFeed(user);
    const before = sec.requests.length;
    const result = await load()(user, instruments);
    expect(sec.requests.length - before).toBe(1 + 2 * 2);
    expect(result.warnings).toEqual(['NOPE: no SEC filings, so its fundamentals are unknown']);
    const beta = result.byId.get('b');
    expect(latestObservation(beta, 'dps_ttm', nowMs)?.value.toNumber()).toBeGreaterThan(2.5);
    expect(latestObservation(result.byId.get('a'), 'dps_ttm', nowMs)).toBeUndefined();
    expect(latestObservation(result.byId.get('a'), 'eps_ttm', nowMs)).toBeDefined();
  });

  it('shares stored filings with other tenants and fetches again only after a day', async () => {
    await addSecFeed(other);
    const before = sec.requests.length;
    const again = await load()(other, instruments);
    // Only the ticker list (cached per provider) at most; no company refetched.
    expect(sec.requests.length - before).toBeLessThanOrEqual(1);
    expect(again.byId.get('b')?.length).toBeGreaterThan(0);
    nowMs += FUNDAMENTALS_TTL_MS + 60_000;
    const later = sec.requests.length;
    await load()(user, instruments);
    expect(sec.requests.filter((p, i) => i >= later && /companyfacts/.test(p))).toHaveLength(2);
  });

  it('keeps a filing as first stored: a later sync adds, never overwrites', async () => {
    const stored = await loadFundamentals(t.worker.db, [9_900_002]);
    const list = stored.get(9_900_002) ?? [];
    const keys = list.map((o) => `${o.field}|${o.accession}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is out of reach of the web login', async () => {
    await expect(t.appSql`select count(*) from fundamental_observation`).rejects.toThrow(
      /permission denied/,
    );
    await expect(t.appSql`select count(*) from fundamental_company`).rejects.toThrow(
      /permission denied/,
    );
  });
});
