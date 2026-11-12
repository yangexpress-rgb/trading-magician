# ADR 0088: The new-user guide video is served by the app and plays with sound from the first click

- **Status:** accepted
- **Date:** 2026-11-12
- **Design refs:** design v1.2 N248; open points O154, O155.

## Context

Yong made a 2-minute narrated guide for people who have just signed up and asked for it to be in
the app, with the narration audible on the first play. Browsers start an autoplayed video muted,
so a video that plays by itself would be silent until the person found the volume control.

## Decision

- **No autoplay, no mute.** The `<video>` element has `controls`, `preload="metadata"`, a poster
  and `playsInline`, and never `autoplay` or `muted` (no attribute, no React prop, no
  `video.muted = true`). A real button labelled "Watch the 2-minute guide" sits over the poster;
  its click handler calls `play()`, so playback begins inside the person's gesture and the
  browser allows sound. Nothing calls `play()` otherwise. Once playing, the browser's own
  controls do pause, seek, volume and fullscreen; there is no custom player.
- **Served from the app.** The MP4 (H.264 + AAC, 1920×1080, 3.4 MB, `moov` atom first so it
  starts before it has fully downloaded) and the poster PNG live in `apps/web/public/guides/`
  and are committed to git. `next start` answers byte-range requests with 206, which Safari
  needs to play video. No Drive or other third-party origin is involved, so the CSP
  (`default-src 'self'`, which also covers `media-src`) is unchanged.
- **Where it shows.** A Welcome card on Strategy Lab (the page sign-up and sign-in land on) until
  the person dismisses it or the video reaches its end, and a permanent copy on a new Help page
  in the primary navigation (O154).
- **Remembered server-side.** `profile.guide_video_done_at` (migration 0089) records the first
  dismissal or completion via the `markGuideVideoDone` server action; the card renders only
  while it is null. Profile rows already belong to the person under row-level security, so no
  new policy or grant is needed, and the choice follows the person to any device.

## Consequences

- A new or replaced guide is a file swap in `apps/web/public/guides/`; keep it small (a few MB)
  and fast-start encoded. A much larger video would belong in object storage instead of git.
- The unit test (`guide-video.test.ts`) fails if the player gains `muted` or `autoplay`; the e2e
  test (`guide-video.spec.ts`) checks the click plays unmuted at desktop and phone sizes, the
  same-origin 206 response, and that dismissal survives a new sign-in.
- Captions are out of scope for now; a WebVTT `<track>` can be added beside the MP4 later.
