/**
 * Which Research tab the sidebar's Quantitative Research link opens (N295):
 * the tab last viewed, while the person comes back within a while in the same
 * sign-in; otherwise, after a break or a new sign-in, the Watch list.
 * Remembered per browser in a cookie the Research tabs renew while open.
 */

export const RESEARCH_TAB_COOKIE = 'tm_research_tab';

export const DEFAULT_RESEARCH_TAB = '/research/watch-list';

/** The Research tabs a link may reopen. */
export const RESEARCH_TABS = [
  '/research/watch-list',
  '/research',
  '/research/screener',
  '/research/deals',
  '/research/patterns',
] as const;

/** Away longer than this, the link opens the Watch list again. */
export const RESEARCH_TAB_IDLE_MS = 30 * 60_000;

/** A tab's path (sub-pages count as their tab) and when it was last viewed. */
export function researchTabOf(pathname: string): string | null {
  const match = [...RESEARCH_TABS]
    .filter((t) => t !== '/research')
    .find((t) => pathname === t || pathname.startsWith(`${t}/`));
  if (match) return match;
  return pathname === '/research' ? '/research' : null;
}

export function formatResearchTab(path: string, at: number): string {
  return encodeURIComponent(`${path}|${Math.floor(at)}`);
}

/** The `document.cookie` assignment that remembers the tab being viewed. */
export function researchTabCookie(path: string, at: number): string {
  return `${RESEARCH_TAB_COOKIE}=${formatResearchTab(path, at)}; Path=/research; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax`;
}

/**
 * Where the link goes: the remembered tab when it was viewed within the idle
 * window and since this sign-in began; the Watch list otherwise.
 */
export function pickResearchTab(
  raw: string | undefined | null,
  now: number,
  signedInAt: number,
): string {
  if (!raw) return DEFAULT_RESEARCH_TAB;
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return DEFAULT_RESEARCH_TAB;
  }
  const [path = '', atText = ''] = text.split('|');
  const at = Number(atText);
  if (!(RESEARCH_TABS as readonly string[]).includes(path) || !Number.isFinite(at))
    return DEFAULT_RESEARCH_TAB;
  if (at < signedInAt || now - at > RESEARCH_TAB_IDLE_MS || at > now + 60_000)
    return DEFAULT_RESEARCH_TAB;
  return path;
}
