'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  type AppTab,
  DEFAULT_TAB_PATH,
  MAX_TABS,
  TABS_STORAGE_KEY,
  opensNewTab,
  readStoredTabs,
  tabPath,
  tabTitle,
} from '@/lib/app-tabs';

let nextId = 0;
const newTab = (url: string): AppTab => ({ id: `t${++nextId}`, src: url, url, title: 'Loading…' });

function initialTabs(open: string | null): { tabs: AppTab[]; active: string } {
  const origin = window.location.origin;
  let stored = null;
  try {
    stored = readStoredTabs(window.localStorage.getItem(TABS_STORAGE_KEY), origin);
  } catch {
    // Storage blocked: start fresh.
  }
  const tabs = (stored?.urls ?? []).map(newTab);
  let active = tabs[stored?.active ?? 0]?.id;
  const wanted = open ? tabPath(open, origin) : null;
  if (wanted) {
    const existing = tabs.find((t) => t.url === wanted);
    if (existing) active = existing.id;
    else {
      const t = newTab(wanted);
      if (tabs.length >= MAX_TABS) tabs.shift();
      tabs.push(t);
      active = t.id;
    }
  }
  if (tabs.length === 0) {
    const t = newTab(DEFAULT_TAB_PATH);
    tabs.push(t);
    active = t.id;
  }
  return { tabs, active: active ?? tabs[0]?.id ?? '' };
}

/**
 * The installed app's tab bar (N253, ADR 0089). Each tab is a same-origin
 * frame running the normal app, so a tab keeps its page and state while
 * another is shown, as browser tabs do. Cmd/Ctrl-click, middle-click and
 * target="_blank" on in-app links open new tabs; so does right-click (N258).
 */
export function TabHost({ open }: { open: string | null }) {
  const [state, setState] = useState<{ tabs: AppTab[]; active: string } | null>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());

  useEffect(() => setState(initialTabs(open)), [open]);

  const openTab = useCallback((url: string, activate: boolean) => {
    setState((s) => {
      if (!s || s.tabs.length >= MAX_TABS) return s;
      const t = newTab(url);
      const i = s.tabs.findIndex((x) => x.id === s.active);
      const tabs = [...s.tabs.slice(0, i + 1), t, ...s.tabs.slice(i + 1)];
      return { tabs, active: activate ? t.id : s.active };
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setState((s) => {
      if (!s) return s;
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      if (tabs.length === 0) {
        const t = newTab(DEFAULT_TAB_PATH);
        return { tabs: [t], active: t.id };
      }
      const active =
        s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? s.active) : s.active;
      return { tabs, active };
    });
  }, []);

  // Remember the open tabs for the next launch.
  useEffect(() => {
    if (!state) return;
    try {
      window.localStorage.setItem(
        TABS_STORAGE_KEY,
        JSON.stringify({
          urls: state.tabs.map((t) => t.url),
          active: state.tabs.findIndex((t) => t.id === state.active),
        }),
      );
    } catch {
      // Storage blocked: tabs just are not remembered.
    }
  }, [state]);

  // Follow each frame's address and title, including client-side navigation.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setState((s) => {
        if (!s) return s;
        let changed = false;
        const tabs = s.tabs.map((t) => {
          const w = frames.current.get(t.id)?.contentWindow;
          if (!w) return t;
          try {
            const url = tabPath(w.location.href, window.location.origin) ?? t.url;
            const title = tabTitle(w.document.title);
            if (url === t.url && title === t.title) return t;
            changed = true;
            return { ...t, url, title };
          } catch {
            return t;
          }
        });
        return changed ? { ...s, tabs } : s;
      });
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  const activeTab = state?.tabs.find((t) => t.id === state.active);
  useEffect(() => {
    document.title = activeTab ? `${activeTab.title} · Trading Magician` : 'Trading Magician';
  }, [activeTab]);

  /** Opens in-app links as tabs when asked to (modifier keys, middle button, target=_blank). */
  const wireFrame = useCallback(
    (frame: HTMLIFrameElement) => {
      const doc = frame.contentDocument;
      if (!doc || (doc as Document & { __tmWired?: boolean }).__tmWired) return;
      (doc as Document & { __tmWired?: boolean }).__tmWired = true;
      const onClick = (e: globalThis.MouseEvent) => {
        if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || a.hasAttribute('download')) return;
        if (
          !opensNewTab({
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
            button: e.button,
            target: a.target || null,
          })
        )
          return;
        const path = tabPath(a.href, window.location.origin);
        if (!path) return; // Other sites keep the browser's own handling.
        e.preventDefault();
        e.stopPropagation();
        // Like a browser: a plain new-window link opens in front; Cmd/Ctrl-click behind.
        openTab(path, a.target === '_blank' && !e.metaKey && !e.ctrlKey && e.button === 0);
      };
      // Right-click on an in-app link opens it in a new tab in front (N258), as
      // Yong uses right-click in the browser; Shift-right-click keeps the menu.
      const onContextMenu = (e: globalThis.MouseEvent) => {
        if (e.defaultPrevented || e.shiftKey) return;
        const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
        if (!a || a.hasAttribute('download')) return;
        const path = tabPath(a.href, window.location.origin);
        if (!path) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        openTab(path, true);
      };
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('auxclick', onClick, true);
      doc.addEventListener('contextmenu', onContextMenu, true);
    },
    [openTab],
  );

  if (!state) return <div className="h-screen bg-canvas" />;

  const full = state.tabs.length >= MAX_TABS;
  const onTabMouseUp = (e: MouseEvent, id: string) => {
    if (e.button === 1) closeTab(id);
  };

  return (
    <div className="flex h-screen flex-col bg-canvas">
      <div className="flex shrink-0 items-end gap-1 overflow-x-auto border-b border-line bg-surface-2 px-2 pt-1.5">
        <div role="tablist" aria-label="Open tabs" className="flex min-w-0 items-end gap-1">
          {state.tabs.map((t) => {
            const selected = t.id === state.active;
            return (
              <div
                key={t.id}
                className={`group flex max-w-[220px] min-w-[120px] items-center rounded-t-md border border-b-0 text-sm ${
                  selected
                    ? 'border-line bg-canvas font-medium text-ink'
                    : 'border-transparent text-ink-muted hover:bg-surface hover:text-ink'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`tabpanel-${t.id}`}
                  title={t.title}
                  onClick={() => setState({ ...state, active: t.id })}
                  onMouseUp={(e) => onTabMouseUp(e, t.id)}
                  className="min-w-0 flex-1 truncate py-1.5 pr-1 pl-3 text-left"
                >
                  {t.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close tab ${t.title}`}
                  title="Close tab"
                  onClick={() => closeTab(t.id)}
                  className="mr-1 rounded px-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="New tab"
          title={full ? `Up to ${MAX_TABS} tabs` : 'New tab'}
          disabled={full}
          onClick={() => openTab(DEFAULT_TAB_PATH, true)}
          className="mb-1 rounded px-2 py-0.5 text-lg leading-none text-ink-muted hover:bg-surface hover:text-ink disabled:opacity-40"
        >
          +
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {state.tabs.map((t) => {
          const selected = t.id === state.active;
          return (
            <iframe
              key={t.id}
              id={`tabpanel-${t.id}`}
              role="tabpanel"
              title={t.title}
              // The first address only; later navigation happens inside the frame.
              src={t.src}
              ref={(el) => {
                if (el) frames.current.set(t.id, el);
                else frames.current.delete(t.id);
              }}
              onLoad={(e) => wireFrame(e.currentTarget)}
              // Hidden tabs keep their size so charts need no re-layout when shown.
              className={`absolute inset-0 h-full w-full border-0 ${selected ? '' : 'invisible'}`}
              aria-hidden={!selected}
              inert={!selected}
              tabIndex={selected ? 0 : -1}
            />
          );
        })}
      </div>
    </div>
  );
}
