import { devices, expect, type Page } from '@playwright/test';
import { PASSWORD, signIn, signUpAndVerify, test, uniqueEmail } from './fixtures';

/** What the guide's <video> is doing right now. */
function videoState(page: Page, scope: string) {
  return page.locator(`${scope} video`).evaluate((v: HTMLVideoElement) => ({
    paused: v.paused,
    muted: v.muted,
    volume: v.volume,
    autoplay: v.autoplay,
    hasMutedAttr: v.hasAttribute('muted'),
    hasAutoplayAttr: v.hasAttribute('autoplay'),
    controls: v.controls,
    preload: v.preload,
    poster: v.getAttribute('poster'),
    playsInline: v.hasAttribute('playsinline'),
    currentSrc: v.currentSrc,
    currentTime: v.currentTime,
  }));
}

test('new users see the guide card; play starts with sound; dismissing keeps the Help copy (N248)', async ({
  page,
  baseURL,
}) => {
  const email = uniqueEmail('guide');
  const media: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'media' || /\.mp4(\?|$)/.test(r.url())) media.push(r.url());
  });

  await signUpAndVerify(page, email);
  const card = page.getByRole('region', { name: 'Welcome to Trading Magician' });
  await expect(card).toBeVisible();
  await expect(
    card.getByText('New here? Watch the guide (2 minutes, with narration).'),
  ).toBeVisible();

  // Nothing plays, and nothing is muted or set to autoplay, before the click.
  const before = await videoState(page, 'main section');
  expect(before).toMatchObject({
    paused: true,
    muted: false,
    autoplay: false,
    hasMutedAttr: false,
    hasAutoplayAttr: false,
    controls: true,
    preload: 'metadata',
    poster: '/guides/new-user-guide-poster.png',
    playsInline: true,
  });
  expect(before.currentTime).toBe(0);
  // Served from the app's own origin, never from Drive.
  expect(new URL(before.currentSrc).origin).toBe(new URL(baseURL!).origin);
  for (const url of media) expect(new URL(url).origin).toBe(new URL(baseURL!).origin);
  const head = await page.request.get('/guides/new-user-guide.mp4', {
    headers: { Range: 'bytes=0-1023' },
  });
  expect(head.status()).toBe(206);
  expect(head.headers()['content-type']).toBe('video/mp4');

  await card.getByRole('button', { name: 'Watch the 2-minute guide' }).click();
  await expect(card.getByRole('button', { name: 'Watch the 2-minute guide' })).toBeHidden();
  await expect
    .poll(async () => (await videoState(page, 'main section')).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(0.5);
  const playing = await videoState(page, 'main section');
  expect(playing).toMatchObject({ paused: false, muted: false, volume: 1 });

  // Dismiss: gone now and on the next sign-in; Help keeps the video.
  await card.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toBeHidden();
  await page.context().clearCookies();
  await signIn(page, email, PASSWORD);
  await expect(page).toHaveURL(/\/strategy-lab$/);
  await expect(page.getByRole('heading', { name: 'Trading Strategy' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Welcome to Trading Magician' })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Help' })
    .click();
  await expect(page.getByRole('heading', { name: 'Help', level: 1 })).toBeVisible();
  const help = await videoState(page, 'main');
  expect(help).toMatchObject({ paused: true, hasMutedAttr: false, hasAutoplayAttr: false });
  await expect(page.getByRole('button', { name: 'Watch the 2-minute guide' })).toBeVisible();
});

test('the guide shrinks to a phone and plays inline with sound (N248)', async ({
  browser,
  baseURL,
}) => {
  const iphone = devices['iPhone 13'];
  const context = await browser.newContext({
    ...iphone,
    extraHTTPHeaders: { 'x-forwarded-for': `10.9.${Date.now() % 250}.7` },
    ...(baseURL ? { baseURL } : {}),
  });
  const page = await context.newPage();
  await signUpAndVerify(page, uniqueEmail('guide-phone'));
  const video = page.locator('main section video');
  const box = (await video.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  expect(Math.abs(box.width / box.height - 16 / 9)).toBeLessThan(0.02);
  await page.getByRole('button', { name: 'Watch the 2-minute guide' }).tap();
  await expect
    .poll(async () => (await videoState(page, 'main section')).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(0.5);
  expect(await videoState(page, 'main section')).toMatchObject({ paused: false, muted: false });
  await context.close();
});
