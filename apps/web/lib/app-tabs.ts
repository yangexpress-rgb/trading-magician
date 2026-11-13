/**
 * Tabs inside the installed desktop app (N253, ADR 0089). Pure helpers for the
 * tab host in `components/tabs/tab-host.tsx`: which links may open as tabs,
 * how tabs are stored, and how titles are shown.
 */

export const TABS_PATH = '/tabs';
export const DEFAULT_TAB_PATH = '/strategy-lab';
export const MAX_TABS = 12;
export const TABS_STORAGE_KEY = 'tm-app-tabs-v1';

export interface AppTab {
  id: string;
  /** The address the tab's frame was created with; never changes, so the frame is not reloaded. */
  src: string;
  /** Path, query and hash inside this app, such as `/orders?status=open`. */
  url: string;
  title: string;
}

export interface StoredTabs {
  urls: string[];
  active: number;
}

/**
 * A path the host may load in a tab: same origin, not the host itself, and
 * not an API route. Returns the path with query and hash, or null.
 */
export function tabPath(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  if (url.pathname === TABS_PATH || url.pathname.startsWith(`${TABS_PATH}/`)) return null;
  if (url.pathname.startsWith('/api/')) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Page title without the app name Next.js adds (`Orders · Trading Magician`). */
export function tabTitle(documentTitle: string): string {
  const t = documentTitle.replace(/\s*·\s*Trading Magician$/, '').trim();
  return t || 'Trading Magician';
}

/** Reads stored tabs, dropping anything that is not a valid in-app path. */
export function readStoredTabs(raw: string | null, origin: string): StoredTabs | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTabs>;
    const urls = (Array.isArray(parsed.urls) ? parsed.urls : [])
      .map((u) => (typeof u === 'string' ? tabPath(u, origin) : null))
      .filter((u): u is string => u !== null)
      .slice(0, MAX_TABS);
    if (urls.length === 0) return null;
    const active =
      typeof parsed.active === 'number' && parsed.active >= 0 && parsed.active < urls.length
        ? parsed.active
        : 0;
    return { urls, active };
  } catch {
    return null;
  }
}

/** True when a click on a link should open it in a new tab instead of in place. */
export function opensNewTab(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  button: number;
  target: string | null;
}): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1 || e.target === '_blank';
}
