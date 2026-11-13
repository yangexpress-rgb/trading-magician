# ADR 0089: The web app installs as its own window; no service worker

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N250, §16.1 (CSP). Requested by Yong 2026-11-13.

## Context

Yong wanted to open Trading Magician from the Mac Dock in its own window, the way TradingView's
desktop app opens, instead of in a browser tab. Three ways were offered: use the browser's own
"Add to Dock"/"Install" as is, make the web app properly installable, or wrap it in a native
desktop app (Electron or similar). Yong chose the second.

## Decision

- **Web app manifest** at `/manifest.webmanifest` (`apps/web/app/manifest.ts`): name
  "Trading Magician", `display: standalone`, `start_url: /strategy-lab`, scope `/`, icons
  192 and 512 px (`purpose: any`, drawn on the macOS icon grid with transparent padding) and a
  full-bleed 512 px `maskable` icon, in `apps/web/public/icons/`.
- **Apple touch icon** (`apps/web/app/apple-icon.png`, 180 px, opaque) and `appleWebApp`
  metadata, so Safari's File > Add to Dock gets the name and icon. Favicon `apps/web/app/icon.svg`.
- **Title bar colour** follows the theme: `theme-color` is the surface colour, white in light
  mode and `#121722` in dark mode.
- **The proxy lets the manifest and icons through without a session.** Browsers fetch the
  manifest without cookies, so the sign-in redirect in `apps/web/proxy.ts` would otherwise
  hide it; `manifest.webmanifest`, `icon.svg`, `apple-icon.png` and `icons/` are left out of its
  matcher. They hold no user data.
- **No service worker and no offline cache.** Chrome no longer needs one to install a site,
  and a cache could show stale prices, orders or positions. Every page still comes live from
  the server; signed-out windows go to sign-in as before.
- **No native wrapper.** A downloadable Mac app would need Apple signing and notarisation to
  install cleanly and would add little over an installed web app.

## Consequences

- Chrome shows an Install icon in the address bar; Safari 17+ on macOS offers File > Add to
  Dock. Either opens the app in its own window with its own Dock icon and no browser tabs.
- Links to other sites still open in the browser. The installed app shares the browser's
  cookies in Chrome; a Safari web app keeps its own website data, so it may ask to sign in once.
- e2e `install-app.spec.ts` checks the manifest and icons load signed out and that Chrome
  reports no installability errors.
