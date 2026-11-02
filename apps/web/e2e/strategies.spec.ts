import AxeBuilder from '@axe-core/playwright';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/** Same-origin JSON calls from the signed-in browser context. */
function api(page: Page, baseURL: string) {
  const req: APIRequestContext = page.request;
  const opts = (data?: unknown) => ({
    headers: { origin: baseURL },
    ...(data === undefined ? {} : { data }),
  });
  return {
    get: (path: string) => req.get(`/api/v1${path}`),
    post: (path: string, data?: unknown) => req.post(`/api/v1${path}`, opts(data ?? {})),
    patch: (path: string, data: unknown) => req.patch(`/api/v1${path}`, opts(data)),
    delete: (path: string, data: unknown) => req.delete(`/api/v1${path}`, opts(data)),
  };
}

test.describe('strategy API', () => {
  test('creates, updates with concurrency checks, duplicates, validates and deletes', async ({
    page,
    baseURL,
  }) => {
    await signUpAndVerify(page, uniqueEmail('api'));
    const a = api(page, baseURL!);

    const created = await a.post('/strategies', { name: '  Pairs  ', tags: ['pairs'] });
    expect(created.status()).toBe(201);
    const s = await created.json();
    expect(s).toMatchObject({ name: 'Pairs', status: 'created', rowVersion: 1 });
    expect(s.definition.risk).toMatchObject({ maxOrderNotional: '10000', maxActiveOrders: 10 });

    const renamed = await a.patch(`/strategies/${s.id}`, { rowVersion: 1, name: 'Pairs v2' });
    expect(renamed.status()).toBe(200);
    expect((await renamed.json()).rowVersion).toBe(2);

    const stale = await a.patch(`/strategies/${s.id}`, { rowVersion: 1, name: 'Lost update' });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('conflict');

    const bad = await a.patch(`/strategies/${s.id}`, { rowVersion: 2, name: '' });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.issues[0].path).toEqual(['name']);

    const validation = await (await a.post(`/strategies/${s.id}/validate`)).json();
    expect(validation.errors.map((e: { code: string }) => e.code)).toEqual(
      expect.arrayContaining(['empty_condition', 'no_orders']),
    );

    const start = await a.post(`/strategies/${s.id}/start`, {
      rowVersion: 2,
      mode: 'paper',
      confirmed: true,
    });
    expect(start.status()).toBe(422);
    expect((await start.json()).error.code).toBe('transition_blocked');

    const live = await a.post(`/strategies/${s.id}/start`, {
      rowVersion: 2,
      mode: 'live',
      confirmed: true,
    });
    expect(live.status()).toBe(400);

    const copy = await a.post(`/strategies/${s.id}/duplicate`);
    expect(copy.status()).toBe(201);
    expect((await copy.json()).name).toBe('Copy of Pairs v2');

    const list = await (await a.get('/strategies?sort=name&direction=asc')).json();
    expect(list.items.map((i: { name: string }) => i.name)).toEqual([
      'Copy of Pairs v2',
      'Pairs v2',
    ]);

    expect((await a.delete(`/strategies/${s.id}`, { rowVersion: 2 })).status()).toBe(204);
    expect((await a.get(`/strategies/${s.id}`)).status()).toBe(404);
  });

  test("never exposes one user's strategies to another", async ({ newPage, baseURL }) => {
    const owner = await newPage();
    await signUpAndVerify(owner, uniqueEmail('owner'));
    const s = await (await api(owner, baseURL!).post('/strategies', { name: 'Secret' })).json();

    const other = await newPage();
    await signUpAndVerify(other, uniqueEmail('other'));
    const b = api(other, baseURL!);
    expect((await b.get(`/strategies/${s.id}`)).status()).toBe(404);
    expect((await b.patch(`/strategies/${s.id}`, { rowVersion: 1, name: 'Mine' })).status()).toBe(
      404,
    );
    expect((await b.post(`/strategies/${s.id}/duplicate`)).status()).toBe(404);
    expect((await b.post(`/strategies/${s.id}/validate`)).status()).toBe(404);
    expect((await b.delete(`/strategies/${s.id}`, { rowVersion: 1 })).status()).toBe(404);
    expect((await (await b.get('/strategies')).json()).items).toEqual([]);

    await other.goto(`/strategy-lab/${s.id}`);
    await expect(other.getByRole('heading', { name: 'Secret' })).toHaveCount(0);

    const still = await (await api(owner, baseURL!).get(`/strategies/${s.id}`)).json();
    expect(still).toMatchObject({ name: 'Secret', rowVersion: 1 });
  });

  test('requires a session and a same-origin request', async ({ page, playwright, baseURL }) => {
    const anonymous = await playwright.request.newContext({ baseURL: baseURL! });
    const res = await anonymous.get('/api/v1/strategies');
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('unauthenticated');
    await anonymous.dispose();

    await signUpAndVerify(page, uniqueEmail('origin'));
    const noOrigin = await page.request.post('/api/v1/strategies', { data: { name: 'x' } });
    expect(noOrigin.status()).toBe(403);
    const foreign = await page.request.post('/api/v1/strategies', {
      data: { name: 'x' },
      headers: { origin: 'https://attacker.example' },
    });
    expect(foreign.status()).toBe(403);
    expect((await (await page.request.get('/api/v1/strategies')).json()).total).toBe(0);
  });
});

test.describe('strategy library', () => {
  test('creates, finds, renames, duplicates, archives and deletes strategies', async ({
    page,
    baseURL,
  }) => {
    await signUpAndVerify(page, uniqueEmail('library'));
    await expect(page.getByRole('heading', { name: 'No strategies yet' })).toBeVisible();

    // Create through the dialog; it opens the new strategy.
    await page.getByRole('button', { name: 'New strategy' }).click();
    const dialog = page.getByRole('dialog', { name: 'New strategy' });
    await dialog.getByLabel('Name').fill('Beverage pairs');
    await dialog.getByRole('button', { name: 'Create strategy' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Beverage pairs' })).toBeVisible();
    await expect(page.getByText('Created', { exact: true }).first()).toBeVisible();

    // A second strategy that trades DEMO-A, created through the API, and moved to Under testing.
    await page.getByRole('link', { name: '← All strategies' }).click();
    const demoA = await page
      .getByLabel('Asset')
      .locator('option', { hasText: 'DEMO-A' })
      .getAttribute('value');
    const a = api(page, baseURL!);
    const withAsset = await (
      await a.post('/strategies', {
        name: 'Momentum A',
        tags: ['momentum'],
        definition: definitionTrading(demoA!),
      })
    ).json();
    await a.patch(`/strategies/${withAsset.id}`, { rowVersion: 1, status: 'under_testing' });
    await page.reload();

    const table = page.getByRole('table', { name: 'Strategies' });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(table.getByRole('row', { name: /Momentum A/ })).toContainText('DEMO-A');
    await expect(table.getByRole('row', { name: /Momentum A/ })).toContainText('Paper');

    // Search, status and asset filters.
    const filter = async (fields: Record<string, string>) => {
      await page.goto('/strategy-lab');
      for (const [label, value] of Object.entries(fields)) {
        const field = page.getByLabel(label, { exact: true });
        if (label === 'Search') await field.fill(value);
        else await field.selectOption({ label: value });
      }
      await page.getByRole('button', { name: 'Apply filters' }).click();
    };
    await filter({ Search: 'MOMENTUM' });
    await expect(table.getByRole('link')).toHaveText(['Momentum A']);
    await filter({ Status: 'Under testing' });
    await expect(table.getByRole('link')).toHaveText(['Momentum A']);
    await filter({ Asset: 'DEMO-A' });
    await expect(table.getByRole('link')).toHaveText(['Momentum A']);
    await filter({ Search: 'nothing like this' });
    await expect(page.getByRole('heading', { name: 'No strategies match' })).toBeVisible();
    await filter({ 'Sort by': 'Name' });
    await expect(table.getByRole('link')).toHaveText(['Beverage pairs', 'Momentum A']);

    // Rename.
    await page.getByRole('button', { name: 'Rename Beverage pairs' }).click();
    const rename = page.getByRole('dialog', { name: 'Rename strategy' });
    await rename.getByLabel('Name').fill('Beverage spread');
    await rename.getByRole('button', { name: 'Save name' }).click();
    await expect(table.getByRole('link', { name: 'Beverage spread' })).toBeVisible();

    // Duplicate.
    await page.getByRole('button', { name: 'Duplicate Beverage spread' }).click();
    await expect(table.getByRole('link', { name: 'Copy of Beverage spread' })).toBeVisible();

    // Archive, then find it under Archived.
    await page.getByRole('button', { name: 'Archive Copy of Beverage spread' }).click();
    await expect(table.getByRole('link', { name: 'Copy of Beverage spread' })).toHaveCount(0);
    await filter({ Show: 'Archived' });
    await expect(table.getByRole('link')).toHaveText(['Copy of Beverage spread']);
    await expectAccessible(page);

    // Delete with confirmation.
    await page.getByRole('button', { name: 'Delete Copy of Beverage spread' }).click();
    await page
      .getByRole('dialog', { name: /Delete/ })
      .getByRole('button', { name: 'Delete strategy' })
      .click();
    await expect(page.getByRole('heading', { name: 'No strategies match' })).toBeVisible();

    // New strategy, copied from an existing one: a fresh draft with the same rules.
    await page.goto('/strategy-lab');
    await page.getByRole('button', { name: 'New strategy' }).click();
    const copyDialog = page.getByRole('dialog', { name: 'New strategy' });
    await copyDialog.getByLabel('A copy of an existing strategy').check();
    await copyDialog.getByLabel('Strategy to copy').selectOption({ label: 'Momentum A' });
    await expect(copyDialog.getByLabel('Name', { exact: true })).toHaveValue('Copy of Momentum A');
    await copyDialog.getByLabel('Name', { exact: true }).fill('Momentum B');
    await expectAccessible(page);
    await copyDialog.getByRole('button', { name: 'Create copy' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Momentum B' })).toBeVisible();
    const copyId = page.url().split('/').pop()!;
    const copied = await (await a.get(`/strategies/${copyId}`)).json();
    expect(copied).toMatchObject({ status: 'created', versions: [] });
    expect(copied.definition).toEqual(
      (await (await a.get(`/strategies/${withAsset.id}`)).json()).definition,
    );

    // "Make a copy" on a strategy's page opens the same dialog with it picked.
    await page.goto(`/strategy-lab/${withAsset.id}`);
    await page.getByRole('link', { name: 'Make a copy' }).click();
    await expect(copyDialog.getByLabel('Strategy to copy')).toHaveValue(withAsset.id);
    await copyDialog.getByRole('button', { name: 'Create copy' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Copy of Momentum A' })).toBeVisible();
  });
});

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

/** Minimal saved definition whose Entry condition reads DEMO-A. */
function definitionTrading(instrumentId: string) {
  const group = (id: string, children: unknown[] = []) => ({
    kind: 'group',
    id,
    op: 'and',
    negate: false,
    children,
  });
  return {
    schemaVersion: 1,
    entry: {
      condition: group('entry-root', [
        {
          kind: 'comparison',
          id: 'c1',
          operator: 'gt',
          left: { kind: 'market', id: 'm1', instrumentId, field: 'close', interval: '1d' },
          right: { kind: 'constant', id: 'k1', value: '100' },
        },
      ]),
      orders: [],
    },
    exit: { condition: group('exit-root'), orders: [] },
    execution: {
      multiLegPolicy: 'concurrent',
      legTimeoutSec: 60,
      onLegFailure: 'cancel_remaining',
      entryMilestone: 'full_fill',
      reentry: { mode: 'single_cycle' },
      marketHoursPolicy: 'queue',
      holidayCalendar: 'NYSE',
      staleDataSec: 60,
    },
    risk: {},
  };
}
