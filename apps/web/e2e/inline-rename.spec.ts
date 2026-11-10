import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

test('a strategy is renamed by double-clicking its name, on its page and in the Lab list (N190)', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('rename'));
  const headers = { origin: baseURL! };
  const created = await (
    await page.request.post('/api/v1/strategies', { data: { name: 'Old name' }, headers })
  ).json();
  const number = created.labNumber as string;
  expect(number).toMatch(/^S\d{5}-/);

  // On the strategy page: double-click the title, type, Enter saves.
  await page.goto(`/strategy-lab/${created.id}`);
  const heading = page.getByRole('heading', { level: 1 });
  await heading.getByText('Old name').dblclick();
  const field = page.getByRole('textbox', { name: 'Strategy name' });
  await expect(field).toBeFocused();
  await field.fill('New name');
  await field.press('Enter');
  await expect(heading).toHaveText('New name');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(axe.violations).toEqual([]);

  // Esc cancels.
  await heading.getByText('New name').dblclick();
  await field.fill('Discarded');
  await field.press('Escape');
  await expect(heading).toHaveText('New name');

  // An empty name is refused and the field stays open.
  await heading.getByText('New name').dblclick();
  await field.fill('   ');
  await field.press('Enter');
  await expect(
    page.getByRole('alert').filter({ hasText: 'A strategy needs a name.' }),
  ).toBeVisible();
  await field.press('Escape');

  // The name changed; the number did not.
  let detail = await (await page.request.get(`/api/v1/strategies/${created.id}`)).json();
  expect(detail.name).toBe('New name');
  expect(detail.labNumber).toBe(number);

  // The builder saves after a rename without a "changed somewhere else" conflict.
  const entry = page.getByRole('region', { name: 'Entry trigger' });
  await entry.getByRole('button', { name: 'Add condition to Entry trigger' }).click();
  await entry
    .getByRole('group', { name: 'Condition 1', exact: true })
    .getByRole('group', { name: 'Right side' })
    .getByLabel('Value', { exact: true })
    .fill('1000');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.locator('#save-state')).toHaveText('All changes saved');
  await expect(heading).toHaveText('New name');

  // The theory it refers to sits under the name; double-click it to pick one (N191).
  const theory = page.getByTitle('Double-click to change the theory').first();
  await expect(theory).toContainText('Theory none referred');
  await theory.dblclick();
  const search = page.getByLabel('Search the Library by number or name');
  await expect(search).toBeFocused();
  // Esc cancels the search and puts the line back as it was (N194).
  await search.fill('trend');
  await page.keyboard.press('Escape');
  await expect(search).toHaveCount(0);
  await expect(theory).toContainText('Theory none referred');
  await expect(theory).toBeFocused();
  await theory.dblclick();
  await expect(search).toBeFocused();
  await expect(page.getByRole('button', { name: 'New Library record' })).toHaveCount(0);
  const choice = page.getByRole('button', { name: /^T\d{5}-[A-Z]{2} .*Not built/ }).first();
  const theoryNumber = ((await choice.textContent()) ?? '').match(/T\d{5}-[A-Z]{2}/)![0];
  await choice.click();
  await expect(
    page.getByRole('link', { name: `Theory Library entry ${theoryNumber}` }),
  ).toBeVisible();
  detail = await (await page.request.get(`/api/v1/strategies/${created.id}`)).json();
  expect(detail.library.registrationNumber).toBe(theoryNumber);
  expect(detail.name).toBe('New name');
  expect(detail.labNumber).toBe(number);

  // In the Lab list: leaving the field saves too, and a single click still opens it.
  await page.goto('/strategy-lab');
  await page.getByRole('link', { name: 'New name' }).dblclick();
  const listField = page.getByRole('textbox', { name: 'Strategy name' });
  await listField.fill('Listed name');
  await listField.blur();
  await expect(page.getByRole('link', { name: 'Listed name' })).toBeVisible();
  detail = await (await page.request.get(`/api/v1/strategies/${created.id}`)).json();
  expect(detail.name).toBe('Listed name');
  expect(detail.labNumber).toBe(number);

  await page.getByRole('link', { name: 'Listed name' }).click();
  await expect(page).toHaveURL(new RegExp(`/strategy-lab/${created.id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Listed name');
});
