# ADR 0089: The web app installs as its own window; no service worker

- **Status:** accepted
- **Date:** 2026-11-13
- **Design refs:** design v1.2 N250, N252, N253, N254, §16.1 (CSP). Requested by Yong 2026-11-13.

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

- Mac: Chrome shows an Install icon in the address bar; Safari 17+ offers File > Add to Dock.
  Windows: Chrome and Edge both install it from the same manifest (Edge: Apps > Install this
  site as an app), with a Start menu and taskbar icon. Either opens the app in its own window with its own Dock icon and no browser tabs.
- Links to other sites still open in the browser. The installed app shares the browser's
  cookies in Chrome; a Safari web app keeps its own website data, so it may ask to sign in once.
- e2e `install-app.spec.ts` checks the manifest and icons load signed out and that Chrome
  reports no installability errors.

## Amendment 2026-11-13 (N252)

- **New icon.** Yong picked "Candles + spark" from three designs: green and red candlesticks
  climbing to a glowing spark on deep indigo. Same files and sizes as above.
- **Sidebar "Install desktop app"** (`apps/web/components/install-app-button.tsx`), under
  Notifications. Chrome and Edge fire `beforeinstallprompt`; the button keeps that event and
  opens the browser's own install prompt. Where there is none (Safari, or Chrome after a
  dismissed prompt or once installed) it opens a dialog with the menu steps for the browser in
  use. It is hidden when the page runs as the installed app (`display-mode: standalone` or
  `tabbed`, or `navigator.standalone`).
- **Tabs in the app window where the browser offers them.** The manifest asks for
  `display_override: ['tabbed', 'standalone']`. Chrome and Edge that support tabbed app windows
  show a tab strip; the others fall back to a plain app window, where Cmd-click (Mac) or
  Ctrl-click (Windows) on a link opens it in another app window. Links are ordinary `<a>`
  elements, so the browser's own new-tab and new-window handling applies.

## Amendment 2026-11-13 (N253): tabs inside the app

Browsers do not yet show tabs in installed app windows by default, so the app draws its own.

- **Tab bar host** at `/tabs` (`apps/web/components/tabs/tab-host.tsx`, helpers in
  `apps/web/lib/app-tabs.ts`). Each tab is a same-origin frame running the normal app with its
  sidebar, so a hidden tab keeps its page, scroll and form state, like a browser tab. Tabs show
  the page title, follow navigation inside the frame, close with × or a middle-click, and up to
  12 can be open. "+" opens Strategy Lab. Open tabs are remembered per browser (localStorage,
  addresses only) and come back when the app is opened again.
- **New tabs from links.** On in-app links, Cmd-click, Ctrl-click and middle-click open a tab
  behind the current one; `target="_blank"` opens one in front. Links to other sites keep the
  browser's handling. API routes and `/tabs` itself never open as tabs.
- **The app window opens into the tab bar.** The manifest `start_url` is `/tabs`. A page shown
  in the installed app's own window (display-mode `standalone`/`tabbed`, or Safari's
  `navigator.standalone`), not inside a frame, replaces itself with `/tabs?open=<its address>`,
  so apps installed before this change get tabs too. Browser tabs are unchanged.
- **Framing by this app only.** `X-Frame-Options` is now `SAMEORIGIN` and CSP
  `frame-ancestors 'self'` (was `DENY`/`'none'`). Other sites still cannot frame the app.
- **Icons moved to `/icons/v2/`.** Chrome and Edge compare icon addresses when they check the
  manifest for updates, so a new address lets installed apps pick up a changed icon on their
  own (within about a day). Safari keeps the icon from install time; re-adding it to the Dock
  refreshes it.

## Amendment 2026-11-13 (N254): right-click opens a tab

Yong opens links in new tabs with right-click. In the app window that went to the browser, so
inside a tab's frame a right-click on an in-app link now opens it as a new tab in front instead
of showing the context menu. Shift-right-click shows the usual menu; links to other sites, API
routes and `/tabs` keep the browser's handling.
