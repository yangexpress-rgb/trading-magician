import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESEARCH_TAB,
  formatResearchTab,
  pickResearchTab,
  researchTabOf,
} from './research-tab';

describe('research tab to reopen (N295)', () => {
  const now = Date.parse('2026-11-17T18:00:00Z');
  const signedIn = now - 2 * 3600_000;

  it('reopens the last tab within 30 minutes in the same sign-in', () => {
    const raw = formatResearchTab('/research/screener', now - 10 * 60_000);
    expect(pickResearchTab(raw, now, signedIn)).toBe('/research/screener');
  });

  it('opens the watch list after a break, a new sign-in or without a cookie', () => {
    expect(pickResearchTab(formatResearchTab('/research', now - 31 * 60_000), now, signedIn)).toBe(
      DEFAULT_RESEARCH_TAB,
    );
    expect(pickResearchTab(formatResearchTab('/research', now - 60_000), now, now - 30_000)).toBe(
      DEFAULT_RESEARCH_TAB,
    );
    expect(pickResearchTab(undefined, now, signedIn)).toBe(DEFAULT_RESEARCH_TAB);
    expect(pickResearchTab('%E0%A4%A', now, signedIn)).toBe(DEFAULT_RESEARCH_TAB);
    expect(pickResearchTab(formatResearchTab('/admin', now), now, signedIn)).toBe(
      DEFAULT_RESEARCH_TAB,
    );
  });

  it('counts a tab’s sub-pages as the tab', () => {
    expect(researchTabOf('/research/patterns/abc')).toBe('/research/patterns');
    expect(researchTabOf('/research')).toBe('/research');
    expect(researchTabOf('/research/open')).toBeNull();
    expect(researchTabOf('/orders')).toBeNull();
  });
});
