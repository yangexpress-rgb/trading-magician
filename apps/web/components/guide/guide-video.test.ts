import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GUIDE_CAPTION, GUIDE_POSTER_SRC, GUIDE_VIDEO_SRC, GuideVideo } from './guide-video';

const html = renderToStaticMarkup(createElement(GuideVideo));
const videoTag = html.match(/<video\b[^>]*>/)?.[0] ?? '';

describe('GuideVideo (N248)', () => {
  it('has controls, metadata preload, a poster and inline playback', () => {
    expect(videoTag).toMatch(/\scontrols(=""|\s|>)/);
    expect(videoTag).toContain('preload="metadata"');
    expect(videoTag).toContain(`poster="${GUIDE_POSTER_SRC}"`);
    expect(videoTag).toMatch(/\splaysinline(=""|\s|>)/i);
    expect(videoTag).toContain(`src="${GUIDE_VIDEO_SRC}"`);
    expect(videoTag).toMatch(/aria-label="[^"]*guide[^"]*"/);
  });

  it('never autoplays and is never muted, so the click starts it with sound', () => {
    expect(videoTag).not.toMatch(/\bmuted\b/i);
    expect(videoTag).not.toMatch(/\bautoplay\b/i);
    const source = readFileSync(
      fileURLToPath(new URL('./guide-video.tsx', import.meta.url)),
      'utf8',
    );
    // No muted prop, no `.muted =`, no autoPlay anywhere in the code.
    expect(source).not.toMatch(/\smuted(\s|=|\/|>)|\.muted\b|autoPlay/);
  });

  it('labels the play control and captions the player', () => {
    expect(html).toMatch(/<button type="button"[^>]*>.*Watch the 2-minute guide<\/button>/);
    expect(html).toContain(`<figcaption class="mt-2 text-sm text-ink-muted">${GUIDE_CAPTION}`);
  });

  it('serves the video and poster from the app itself', () => {
    expect(GUIDE_VIDEO_SRC.startsWith('/')).toBe(true);
    for (const path of [GUIDE_VIDEO_SRC, GUIDE_POSTER_SRC]) {
      const file = fileURLToPath(new URL(`../../public${path}`, import.meta.url));
      expect(statSync(file).size).toBeGreaterThan(10_000);
    }
  });
});
