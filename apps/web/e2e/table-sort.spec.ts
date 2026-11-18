import { expect, type Locator, type Page } from '@playwright/test';
import { createDb, setPlatformAdmin } from '@tm/db';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/** Report lists sort by any column header (N303). */

async function makeAdmin(email: string): Promise<void> {
  const ownerUrl = process.env.DATABASE_URL;
  const authUrl = process.env.DATABASE_AUTH_URL;
  if (!ownerUrl || !authUrl) throw new Error('DATABASE_URL and DATABASE_AUTH_URL are required');
  const owner = createDb(ownerUrl, { max: 1 });
  const auth = createDb(authUrl, { max: 1 });
  try {
    await setPlatformAdmin(owner.db, auth.db, email, true);
  } finally {
    await Promise.all([owner.close(), auth.close()]);
  }
}

const collator = new Intl.Collator('en-US', { numeric: true, sensitivity: 'base' });

/** The text of one column's cells, top to bottom. */
async function column(table: Locator, index: number): Promise<string[]> {
  return table
    .locator('tbody tr')
    .evaluateAll(
      (rows, i) => rows.map((r) => (r as HTMLTableRowElement).cells[i]?.textContent?.trim() ?? ''),
      index,
    );
}

const users = (page: Page) => page.getByRole('table', { name: 'Users' });
const header = (page: Page, name: string) =>
  users(page).getByRole('columnheader', { name: new RegExp(`^${name}`) });

test('a report list sorts by a column header, both ways, and back to its own order', async ({
  page,
  newPage,
}) => {
  const stamp = Date.now();
  for (const name of ['Zoe Sorter', 'Abe Sorter']) {
    await signUpAndVerify(await newPage(), uniqueEmail(`sort-${stamp}`), name);
  }
  const adminEmail = uniqueEmail('sort-admin');
  await signUpAndVerify(page, adminEmail, 'Mia Sorter');
  await makeAdmin(adminEmail);

  await page.goto('/admin/users');
  const table = users(page);
  await expect(table.locator('tbody tr')).not.toHaveCount(0);
  const before = await column(table, 0);
  expect(before.length).toBeGreaterThanOrEqual(3);

  // First click: low to high.
  await header(page, 'Person').getByRole('button').click();
  await expect(header(page, 'Person')).toHaveAttribute('aria-sort', 'ascending');
  await expect.poll(() => column(table, 0)).toEqual([...before].sort(collator.compare));

  // Second click: high to low.
  await header(page, 'Person').getByRole('button').click();
  await expect(header(page, 'Person')).toHaveAttribute('aria-sort', 'descending');
  await expect
    .poll(() => column(table, 0))
    .toEqual([...before].sort((a, b) => collator.compare(b, a)));

  // A number column sorts by value, not as text.
  await header(page, 'Strategies').getByRole('button').click();
  await expect(header(page, 'Person')).toHaveAttribute('aria-sort', 'none');
  await expect(header(page, 'Strategies')).toHaveAttribute('aria-sort', 'ascending');
  const counts = (await column(table, 3)).map((t) => Number.parseInt(t, 10));
  expect(counts).toEqual([...counts].sort((a, b) => a - b));

  // The choice is remembered in this browser.
  await page.reload();
  await expect(header(page, 'Strategies')).toHaveAttribute('aria-sort', 'ascending');

  // Two more clicks: high to low, then the list's own order again.
  await header(page, 'Strategies').getByRole('button').click();
  await header(page, 'Strategies').getByRole('button').click();
  await expect(header(page, 'Strategies')).toHaveAttribute('aria-sort', 'none');
  await expect.poll(() => column(table, 0)).toEqual(before);

  // An actions column has nothing to sort.
  await expect(table.locator('thead th').last().getByRole('button')).toHaveCount(0);
});
