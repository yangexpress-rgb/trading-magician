import { MAX_COMPARE } from './chart-history';

/**
 * The Price charts page opens on the symbol (and compared symbols) the person
 * last looked at, kept per browser in a cookie so the server can render it
 * straight away (N279). An explicit `instrument=` in the address still wins.
 */
export const LAST_VIEW_COOKIE = 'tm_research_last';

/** About a year; the cookie is renewed on every visit. */
const MAX_AGE_S = 60 * 60 * 24 * 365;

export interface LastView {
  instrumentId: string;
  compare: string[];
}

/** Cookie value: the instrument id, then `|` and the compared ids joined by commas. */
export function formatLastView(view: LastView): string {
  return encodeURIComponent([view.instrumentId, view.compare.join(',')].join('|'));
}

/** The remembered view, or null for a missing or broken cookie. */
export function parseLastView(raw: string | undefined | null): LastView | null {
  if (!raw) return null;
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const [instrumentId = '', rest = ''] = text.split('|');
  if (!instrumentId.trim()) return null;
  const compare = [...new Set(rest.split(',').filter((id) => id && id !== instrumentId))].slice(
    0,
    MAX_COMPARE,
  );
  return { instrumentId, compare };
}

/** The `document.cookie` assignment that remembers this view. */
export function lastViewCookie(view: LastView): string {
  return `${LAST_VIEW_COOKIE}=${formatLastView(view)}; Path=/research; Max-Age=${MAX_AGE_S}; SameSite=Lax`;
}
