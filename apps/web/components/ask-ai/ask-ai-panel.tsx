'use client';

import { AskAiIcon, Button, cx } from '@tm/ui';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  askLink,
  askTargets,
  buildPrompt,
  COPY_TARGET,
  FOCUS_LABEL,
  focusFromUrl,
  MAX_PAGE_TEXT,
  MAX_QUESTION,
  tidyText,
  type AskTarget,
  type ScreenContent,
} from '@/lib/ask-ai';

/** Opens or closes the panel from anywhere, such as the sidebar button. */
export const ASK_AI_EVENT = 'tm:ask-ai';
const OPEN_KEY = 'tm.askAi.open';
const TARGET_KEY = 'tm.askAi.target';
/** Page text that goes into an agent's prefill link, to keep the link a sensible length. */
const LINK_TEXT_MAX = 2500;

const store = {
  get(key: string) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Private windows may refuse storage; the panel still works.
    }
  },
};

/** What the page shows now: its address, title, main heading and text. */
function captureScreen(): ScreenContent {
  const main = document.getElementById('main');
  const heading = main?.querySelector('h1')?.textContent?.trim() || undefined;
  const { focus, filters } = focusFromUrl(window.location.pathname, window.location.search);
  return {
    title: document.title.slice(0, 200),
    heading: heading?.slice(0, 300),
    path: window.location.pathname,
    url: window.location.href.slice(0, 2000),
    focus,
    filters: Object.keys(filters).length ? filters : undefined,
    text: main ? tidyText(main.innerText, MAX_PAGE_TEXT) : undefined,
    capturedAt: new Date().toISOString(),
  };
}

type Outcome =
  | { kind: 'opened'; label: string; code?: string | undefined }
  | { kind: 'copied'; code?: string | undefined }
  | { kind: 'error'; message: string };

/**
 * The Ask AI side panel (N272, ADR 0093): ask any AI agent about the screen
 * you are on. It shows what it picked up from the page, which you can trim,
 * and hands your question to the agent you pick. Connected agents read the
 * screen themselves through get_screen_context; others get it in the prompt.
 */
export function AskAiPanel({ connectedProfiles }: { connectedProfiles: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<ScreenContent | null>(null);
  const [includeText, setIncludeText] = useState(true);
  const [showText, setShowText] = useState(false);
  const [question, setQuestion] = useState('');
  const targets = askTargets(connectedProfiles);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? COPY_TARGET.id);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  const refresh = useCallback(() => setScreen(captureScreen()), []);

  // Remembered per browser: open or closed, and the agent last asked.
  useEffect(() => {
    if (store.get(OPEN_KEY) === '1') setOpen(true);
    const saved = store.get(TARGET_KEY);
    if (saved && askTargets(connectedProfiles).some((t) => t.id === saved)) setTargetId(saved);
  }, [connectedProfiles]);

  useEffect(() => {
    const onToggle = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean }>).detail?.open;
      setOpen((was) => want ?? !was);
    };
    window.addEventListener(ASK_AI_EVENT, onToggle);
    return () => window.removeEventListener(ASK_AI_EVENT, onToggle);
  }, []);

  useEffect(() => {
    store.set(OPEN_KEY, open ? '1' : '0');
    document.documentElement.classList.toggle('ask-ai-open', open);
    if (open) questionRef.current?.focus();
    return () => document.documentElement.classList.remove('ask-ai-open');
  }, [open]);

  // Picks the screen up again when the page changes under an open panel;
  // the short wait lets the new page render first.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(refresh, 400);
    setOutcome(null);
    return () => window.clearTimeout(t);
  }, [open, pathname, searchParams, refresh]);

  const target = targets.find((t) => t.id === targetId) ?? targets[0] ?? COPY_TARGET;

  const content = (): ScreenContent | null =>
    screen && { ...screen, text: includeText ? screen.text : undefined };

  async function saveSnapshot(c: ScreenContent): Promise<string> {
    const res = await fetch('/api/v1/screen-snapshots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.trim(), content: c }),
    });
    const body = (await res.json().catch(() => null)) as {
      code?: string;
      error?: { message?: string };
    } | null;
    if (!res.ok || !body?.code) {
      throw new Error(body?.error?.message ?? 'The screen could not be saved for the agent.');
    }
    return body.code;
  }

  async function ask(t: AskTarget) {
    const c = content();
    if (!c || !question.trim()) return;
    store.set(TARGET_KEY, t.id);
    setBusy(true);
    setOutcome(null);
    // Opened now, while the click still counts, so pop-up blockers allow it.
    const win = t.askUrl ? window.open('about:blank', '_blank') : null;
    try {
      const code = t.connected ? await saveSnapshot(c) : undefined;
      if (t.askUrl) {
        const prompt = buildPrompt({ question, content: c, code, inlineTextMax: LINK_TEXT_MAX });
        const url = askLink(t, prompt);
        if (win) {
          win.opener = null;
          win.location.href = url;
        } else {
          window.open(url, '_blank', 'noopener');
        }
        setOutcome({ kind: 'opened', label: t.label, code });
      } else {
        const connectedAny = connectedProfiles.length > 0;
        const copyCode = connectedAny ? await saveSnapshot(c) : undefined;
        // Copy prompt carries the whole screen, so it works with any agent;
        // a connected agent can also read it by code.
        const prompt = buildPrompt({ question, content: c, inlineTextMax: MAX_PAGE_TEXT });
        const withCode = copyCode
          ? `${prompt}\n\n(If you have the Trading Magician tools, get_screen_context code ${copyCode} has the same screen.)`
          : prompt;
        await navigator.clipboard.writeText(withCode);
        setOutcome({ kind: 'copied', code: copyCode });
      }
    } catch (err) {
      win?.close();
      setOutcome({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Something went wrong. Try again.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const textLength = screen?.text?.length ?? 0;

  return (
    <aside
      aria-labelledby={titleId}
      className="fixed inset-x-0 bottom-0 z-40 flex max-h-[85vh] flex-col border-t border-line bg-surface text-ink shadow-xl md:inset-y-0 md:right-0 md:left-auto md:max-h-none md:w-[380px] md:border-t-0 md:border-l"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id={titleId} className="flex items-center gap-2 font-semibold">
          <AskAiIcon /> Ask AI
        </h2>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-line px-2 py-1 text-sm hover:bg-surface-2"
        >
          Close<span className="sr-only"> Ask AI</span>
        </button>
      </div>

      <form
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(target);
        }}
      >
        <section
          aria-label="What the agent will see"
          className="rounded-md bg-surface-2 p-3 text-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs text-ink-muted">From this screen</p>
              <p className="truncate font-medium" title={screen?.heading ?? screen?.title}>
                {screen?.heading ?? screen?.title ?? 'Reading the page…'}
              </p>
            </div>
            <button
              type="button"
              onClick={refresh}
              className="shrink-0 text-xs text-ink-muted underline hover:text-ink"
            >
              Update
            </button>
          </div>
          {screen && screen.focus.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1">
              {screen.focus.map((f) => (
                <li
                  key={`${f.kind}:${f.ref}`}
                  className="rounded-full border border-line bg-surface px-2 py-0.5 text-xs"
                >
                  {FOCUS_LABEL[f.kind]} <span className="text-content">{f.ref}</span>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              checked={includeText}
              onChange={(e) => setIncludeText(e.target.checked)}
            />
            Include the text on this page
            <span className="text-xs text-ink-muted">
              ({textLength.toLocaleString()} characters)
            </span>
          </label>
          {includeText && screen?.text && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowText((s) => !s)}
                className="text-xs text-ink-muted underline hover:text-ink"
                aria-expanded={showText}
              >
                {showText ? 'Hide the text' : 'Check or trim the text'}
              </button>
              {showText && (
                <textarea
                  aria-label="Page text the agent will see"
                  value={screen.text}
                  onChange={(e) =>
                    setScreen((s) => s && { ...s, text: e.target.value.slice(0, MAX_PAGE_TEXT) })
                  }
                  className="mt-2 h-48 w-full rounded-md border border-line bg-surface p-2 font-mono text-xs"
                />
              )}
            </div>
          )}
        </section>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Your question</span>
          <textarea
            ref={questionRef}
            value={question}
            maxLength={MAX_QUESTION}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void ask(target);
              }
            }}
            placeholder="e.g. Why did this back test lose money in March?"
            className="h-28 rounded-md border border-line bg-surface p-2"
          />
        </label>

        <fieldset className="text-sm">
          <legend className="mb-1 font-medium">Ask</legend>
          <div className="flex flex-col gap-1">
            {targets.map((t) => (
              <label
                key={t.id}
                className={cx(
                  'flex items-center gap-2 rounded-md border px-3 py-2',
                  t.id === target.id ? 'border-accent bg-surface-2' : 'border-line',
                )}
              >
                <input
                  type="radio"
                  name="ask-target"
                  value={t.id}
                  checked={t.id === target.id}
                  onChange={() => setTargetId(t.id)}
                />
                <span className="flex-1">{t.label}</span>
                <span className="text-xs text-ink-muted">
                  {t.id === 'copy'
                    ? 'Any other agent'
                    : t.connected
                      ? 'Connected'
                      : 'Not connected'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <Button type="submit" variant="primary" disabled={busy || !question.trim() || !screen}>
            {busy ? 'Getting ready…' : target.id === 'copy' ? 'Copy prompt' : `Ask ${target.label}`}
          </Button>
          <p className="mt-2 text-xs text-ink-muted">
            {target.id === 'copy'
              ? 'Copies your question and this screen, to paste into any AI agent.'
              : target.connected
                ? `Opens ${target.label} in a new tab with your question filled in. ${target.label} reads this screen through its Trading Magician connection. Nothing is sent until you send it there.`
                : `Opens ${target.label} in a new tab with your question and this screen filled in. Nothing is sent until you send it there.`}
          </p>
          {!target.connected && target.id !== 'copy' && (
            <p className="mt-1 text-xs text-ink-muted">
              <Link href="/settings/ai-agents" className="underline">
                Connect {target.label}
              </Link>{' '}
              so it can read the whole screen and look things up for you.
            </p>
          )}
        </div>

        <div aria-live="polite" className="text-sm">
          {outcome?.kind === 'opened' && (
            <p className="rounded-md bg-surface-2 p-3">
              {outcome.label} opened in a new tab with your question. Check it and send it there.
              {outcome.code && (
                <span className="mt-1 block text-xs text-ink-muted">
                  Screen code <span className="font-mono text-content">{outcome.code}</span>, kept
                  for 24 hours.
                </span>
              )}
            </p>
          )}
          {outcome?.kind === 'copied' && (
            <p className="rounded-md bg-surface-2 p-3">Copied. Paste it into your AI agent.</p>
          )}
          {outcome?.kind === 'error' && (
            <p className="rounded-md bg-surface-2 p-3 text-danger">{outcome.message}</p>
          )}
        </div>
      </form>
    </aside>
  );
}

/** Sidebar button that opens and closes the panel. */
export function AskAiButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(ASK_AI_EVENT))}
      className="inline-flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
    >
      <AskAiIcon />
      Ask AI
    </button>
  );
}
