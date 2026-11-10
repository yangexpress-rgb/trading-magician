import { expect } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/**
 * Moving a price chart through time and comparing symbols on it (N196–N198):
 * go to a date or step a range back, scroll and zoom through the bars (older
 * ones are fetched as needed), and draw other symbols as percent changes.
 */

const nyToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());

test('steps back a week, goes to a date and comes back to the latest', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('chart-date'));
  await page.goto('/research');
  const chart = page.getByTestId('price-chart');
  await expect(chart).toHaveAttribute('aria-label', /^DEMO-IDX, 5-minute prices over 1 day/);

  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1W' }).click();
  await expect(chart).toHaveAttribute('aria-label', /hourly prices over 1 week/);
  const date = page.getByRole('group', { name: 'Date' });
  await expect(date.getByLabel('Chart ends on')).toHaveValue(nyToday());
  await expect(date.getByRole('button', { name: 'Latest' })).toBeDisabled();

  // One week back.
  await date.getByRole('button', { name: 'Previous 1 week' }).click();
  await expect(page).toHaveURL(/date=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByTestId('chart-summary')).toContainText(/1 week to \w{3} \d+, \d{4}/);
  await expect(chart).toHaveAttribute('aria-label', /hourly prices over 1 week/);
  await expect(page.getByTestId('chart-readout')).not.toContainText('latest');

  // A chosen day, kept on reload.
  await date.getByLabel('Chart ends on').fill('2026-03-13');
  await expect(page).toHaveURL(/date=2026-03-13/);
  await page.reload();
  await expect(date.getByLabel('Chart ends on')).toHaveValue('2026-03-13');
  await expect(page.getByTestId('chart-span')).toContainText('Mar 13');

  // A single day steps by trading days: back from Monday 16 March is Friday 13 March.
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1D' }).click();
  await date.getByLabel('Chart ends on').fill('2026-03-16');
  await date.getByRole('button', { name: 'Previous trading day' }).click();
  await expect(date.getByLabel('Chart ends on')).toHaveValue('2026-03-13');
  await expect(page.getByTestId('chart-readout')).toContainText('Mar 13');

  await date.getByRole('button', { name: 'Latest' }).click();
  await expect(page).not.toHaveURL(/date=/);
  await expect(page.getByTestId('chart-readout')).toContainText('latest');
});

test('scrolls and zooms through time, fetching older bars', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('chart-scroll'));
  await page.goto('/research');
  const chart = page.getByTestId('price-chart');
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '1M' }).click();
  await expect(chart).toHaveAttribute('aria-label', /daily prices over 1 month/);
  const span = page.getByTestId('chart-span');
  const opening = await span.textContent();

  // The buttons scroll back; older bars come from the feed and the view keeps moving.
  const tools = page.getByRole('toolbar', { name: 'Move the chart' });
  await tools.getByRole('button', { name: 'Scroll back in time' }).click();
  await expect(chart).toHaveAttribute('aria-label', /daily prices from /);
  await expect(span).not.toHaveText(opening ?? '');
  for (let i = 0; i < 4; i++) {
    await tools.getByRole('button', { name: 'Scroll back in time' }).click();
  }
  await expect(span).toContainText(/\d{4}/);
  const back = await span.textContent();
  await tools.getByRole('button', { name: 'Scroll forward in time' }).click();
  await expect(span).not.toHaveText(back ?? '');

  // Dragging the chart to the right shows earlier bars.
  const before = await span.textContent();
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(span).not.toHaveText(before ?? '');

  // Zoom out shows more bars; Reset goes back to the opening month.
  const bars = async () =>
    Number(/(\d+) bars\.$/.exec((await chart.getAttribute('aria-label')) ?? '')?.[1]);
  const n = await bars();
  await tools.getByRole('button', { name: 'Zoom out: show more bars' }).click();
  await expect.poll(bars).toBeGreaterThan(n);
  await tools.getByRole('button', { name: 'Back to the opening view' }).click();
  await expect(chart).toHaveAttribute('aria-label', /daily prices over 1 month/);
  await expect(span).toHaveText(opening ?? '');
});

test('compares other symbols on the same chart as percent changes', async ({ page }) => {
  await signUpAndVerify(page, uniqueEmail('chart-compare'));
  await page.goto('/research');
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '3M' }).click();
  const chart = page.getByTestId('price-chart');
  await expect(chart).toHaveAttribute('aria-label', /daily prices over 3 months/);

  const add = page.getByLabel('Add a symbol to compare');
  await add.fill('demo-a');
  await add.press('Enter');
  await add.fill('DEMO-B');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  const legend = page.getByTestId('compare-legend');
  await expect(legend.getByRole('listitem')).toHaveText([/DEMO-IDX/, /DEMO-A/, /DEMO-B/]);
  await expect(legend).toContainText('%');
  await expect(page.getByTestId('compare-line-DEMO-A')).toBeVisible();
  await expect(page.getByTestId('compare-line-DEMO-B')).toBeVisible();
  await expect(page).toHaveURL(/compare=[0-9a-f-]{36}(,|%2C)[0-9a-f-]{36}/);

  // The same symbol twice is refused.
  await add.fill('DEMO-A');
  await add.press('Enter');
  await expect(page.getByText('DEMO-A is already on the chart.')).toBeVisible();

  // Compared closes are in the table too.
  await page.getByText('Show prices as a table').click();
  const table = page.getByRole('table', { name: 'DEMO-IDX prices' });
  await expect(table.getByRole('columnheader', { name: 'DEMO-A close $' })).toBeVisible();

  // Scrolling back fetches the compared symbols too.
  await page
    .getByRole('toolbar', { name: 'Move the chart' })
    .getByRole('button', { name: 'Scroll back in time' })
    .click();
  await expect(chart).toHaveAttribute('aria-label', /daily prices from /);
  await expect(page.getByTestId('compare-line-DEMO-A')).toBeVisible();

  // Kept on reload; taken off with its button.
  await page.reload();
  await expect(legend.getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Stop comparing DEMO-A' }).click();
  await expect(legend.getByRole('listitem')).toHaveText([/DEMO-IDX/, /DEMO-B/]);
  await page.getByRole('button', { name: 'Stop comparing DEMO-B' }).click();
  await expect(legend).toBeHidden();
  await expect(page).not.toHaveURL(/compare=/);
});
