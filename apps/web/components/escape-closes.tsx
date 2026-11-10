'use client';

import { useEffect } from 'react';

/**
 * Esc closes the open dropdown and puts the display back as it was (N194),
 * everywhere in the app. Native <select> lists and dialogs already do this;
 * this covers the disclosure dropdowns built on <details> (such as the
 * screener's Columns list). The one holding the keyboard focus closes first,
 * otherwise the one opened last. Components with their own Esc handling (the
 * theory search, inline rename, dialogs) mark the key as handled and are left
 * alone.
 */
export function EscapeCloses() {
  useEffect(() => {
    const opened: HTMLDetailsElement[] = [];
    const onToggle = (e: Event) => {
      const el = e.target;
      if (!(el instanceof HTMLDetailsElement)) return;
      const i = opened.indexOf(el);
      if (i >= 0) opened.splice(i, 1);
      if (el.open) opened.push(el);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      const active = document.activeElement;
      // A modal dialog closes itself; its page's dropdowns stay as they are.
      if (active?.closest('dialog[open]')) return;
      const target =
        active?.closest<HTMLDetailsElement>('details[open]') ??
        [...opened].reverse().find((d) => d.open && d.isConnected);
      if (!target) return;
      e.preventDefault();
      target.open = false;
      target.querySelector<HTMLElement>(':scope > summary')?.focus();
    };
    // `toggle` does not bubble: listen in the capture phase.
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('toggle', onToggle, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return null;
}
