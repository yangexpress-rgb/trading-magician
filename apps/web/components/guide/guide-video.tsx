'use client';

import { useRef, useState } from 'react';

/** Served from the app's own origin (apps/web/public/guides), never from Drive (N248). */
export const GUIDE_VIDEO_SRC = '/guides/new-user-guide.mp4';
export const GUIDE_POSTER_SRC = '/guides/new-user-guide-poster.png';
export const GUIDE_CAPTION = 'New here? Watch the guide (2 minutes, with narration).';

/**
 * The new-user guide (N248, ADR 0088). Sound is on by construction: no
 * autoplay and no `muted`, so nothing plays until the person clicks, and that
 * click is the gesture that lets the browser start playback with sound. The
 * native controls do pause, seek, volume and fullscreen once it plays.
 */
export function GuideVideo({ onEnded }: { onEnded?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);

  const start = () => {
    const el = video.current;
    if (!el) return;
    setStarted(true);
    // Called from the click handler, so it runs inside the user gesture.
    el.play().catch(() => setStarted(false));
  };

  return (
    <figure className="w-full max-w-3xl">
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        <video
          ref={video}
          src={GUIDE_VIDEO_SRC}
          poster={GUIDE_POSTER_SRC}
          controls
          preload="metadata"
          playsInline
          aria-label="Trading Magician new-user guide, 2 minutes, with narration"
          title="Trading Magician new-user guide"
          className="absolute inset-0 h-full w-full"
          onPlay={() => setStarted(true)}
          onEnded={onEnded}
        />
        {!started && (
          <button
            type="button"
            onClick={start}
            className="absolute top-1/2 left-1/2 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-accent px-3 py-1.5 text-xs sm:px-5 sm:py-3 sm:text-sm font-semibold whitespace-nowrap text-accent-ink shadow-lg hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <svg viewBox="0 0 24 24" width="1.25em" height="1.25em" aria-hidden="true">
              <path d="M8 5v14l11-7z" fill="currentColor" />
            </svg>
            Watch the 2-minute guide
          </button>
        )}
      </div>
      <figcaption className="mt-2 text-sm text-ink-muted">{GUIDE_CAPTION}</figcaption>
    </figure>
  );
}
