import { expect, type Page } from '@playwright/test';
import { signUpAndVerify, test, uniqueEmail } from './fixtures';

/** Common Mac screen widths: 13" and 14", 16", and an external 1080p display. */
const WIDTHS = [1440, 1728, 1920];

/** Selects whose chosen option is wider than the space the box gives it. */
async function clippedSelects(page: Page): Promise<string[]> {
  return page.locator('main select').evaluateAll((selects) => {
    const ctx = document.createElement('canvas').getContext('2d')!;
    return (selects as HTMLSelectElement[])
      .filter((s) => s.offsetParent !== null)
      .filter((s) => {
        const style = getComputedStyle(s);
        ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const text = s.selectedOptions[0]?.text ?? '';
        // Padding plus room for the dropdown arrow.
        const room = s.clientWidth - parseFloat(style.paddingLeft) - 28;
        return ctx.measureText(text).width > room;
      })
      .map((s) => `${s.id || s.name}: ${s.selectedOptions[0]?.text}`);
  });
}

test('pages fill wide screens and editor dropdowns show their whole value', async ({
  page,
  baseURL,
}) => {
  await signUpAndVerify(page, uniqueEmail('layout'));
  const res = await page.request.post('/api/v1/strategies', {
    data: { name: 'Layout check' },
    headers: { origin: baseURL! },
  });
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/strategy-lab/${id}`);

  const entry = page.getByRole('region', { name: 'Entry conditions' });
  await entry.getByRole('button', { name: 'Add condition to Entry conditions' }).click();
  const c1 = entry.getByRole('group', { name: 'Condition 1', exact: true });
  for (const name of ['Left side', 'Right side']) {
    const s = c1.getByRole('group', { name, exact: true });
    await s.getByLabel('Type', { exact: true }).selectOption({ label: 'Indicator' });
    await s.getByLabel('Indicator').selectOption({ label: 'Simple moving average (SMA)' });
  }
  await page.getByRole('button', { name: /Add Entry order/ }).click();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await clippedSelects(page), `clipped at ${width}px`).toEqual([]);
    // The content column uses the screen beside the 232px sidebar, not a fixed width.
    const main = await page.locator('main').boundingBox();
    expect(main!.width).toBeGreaterThan((width - 232) * 0.95);
  }
});
