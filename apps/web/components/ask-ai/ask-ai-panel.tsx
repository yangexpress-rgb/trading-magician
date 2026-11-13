'use client';

import { AskAiIcon, Button } from '@tm/ui';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  askLink,
  buildPrompt,
  FOCUS_LABEL,
  focusFromUrl,
  MAX_CHAT_MESSAGE,
  MAX_CHAT_TURNS,
  MAX_PAGE_TEXT,
  tidyText,
  type ScreenContent,
} from '@/lib/ask-ai';

/** Opens or closes the panel from anywhere, such as the sidebar button. */
export const ASK_AI_EVENT = 'tm:ask-ai';
const OPEN_KEY = 'tm.askAi.open';
const CHAT_KEY = 'tm.askAi.chat';
/** Page text that goes into a prefill link, to keep the link a sensible length. */
const LINK_TEXT_MAX = 2500;

/**
 * The person's Ask AI agent, as the panel needs it: one it chats with (N274),
 * or one it opens in its own tab with the question filled in, Muse or Claude
 * on the person's claude.ai plan (N275).
 */
export type AskAgent =
  | { kind: 'chat'; label: string }
  | { kind: 'link'; name: string; askUrl: string; connected: boolean }
  | { kind: 'none' };

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  steps?: { tool: string; ok: boolean }[];
}

function storage(kind: 'local' | 'session') {
  return {
    get(key: string) {
      try {
        return (kind === 'local' ? window.localStorage : window.sessionStorage).getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string) {
      try {
        (kind === 'local' ? window.localStorage : window.sessionStorage).setItem(key, value);
      } catch {
        // Private windows may refuse storage; the panel still works.
      }
    },
  };
}
const local = storage('local');
const session = storage('session');

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

const TOOL_WORDS: Record<string, string> = {
  search_theories: 'searched theories',
  get_theory: 'read a theory',
  list_strategies: 'listed strategies',
  get_strategy: 'read a strategy',
  list_backtests: 'listed back tests',
  get_backtest: 'read a back test',
  screen_stocks: 'ran the screener',
  get_paper_accounts: 'read paper accounts',
  get_screen_context: 'read your screen',
  create_strategy: 'created a strategy',
  update_strategy: 'changed a strategy',
  run_backtest: 'started a back test',
  create_theory: 'created a theory',
};

/**
 * The Ask AI side panel (N272, N274, N275; ADR 0093–0095): a chat with the one
 * AI agent the person chose in Settings › AI agents, beside whatever screen they
 * are on. Each message carries the screen. Muse and Claude on a claude.ai plan
 * have no API for the app, so for them the panel has one Ask button that opens
 * the agent with the question filled in.
 */
export function AskAiPanel({ agent }: { agent: AskAgent }) {
  const [open, setOpen] = useState(false);
  const [screen, setScreen] = useState<ScreenContent | null>(null);
  const [includeText, setIncludeText] = useState(true);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const refresh = useCallback(() => setScreen(captureScreen()), []);

  // Open or closed is remembered per browser; the chat for this browser tab.
  useEffect(() => {
    if (local.get(OPEN_KEY) === '1') setOpen(true);
    try {
      const saved = JSON.parse(session.get(CHAT_KEY) ?? '[]') as Turn[];
      if (Array.isArray(saved)) setTurns(saved);
    } catch {
      // A damaged saved chat starts afresh.
    }
  }, []);

  useEffect(() => {
    session.set(CHAT_KEY, JSON.stringify(turns));
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  useEffect(() => {
    const onToggle = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean }>).detail?.open;
      setOpen((was) => want ?? !was);
    };
    window.addEventListener(ASK_AI_EVENT, onToggle);
    return () => window.removeEventListener(ASK_AI_EVENT, onToggle);
  }, []);

  useEffect(() => {
    local.set(OPEN_KEY, open ? '1' : '0');
    document.documentElement.classList.toggle('ask-ai-open', open);
    if (open) inputRef.current?.focus();
    return () => document.documentElement.classList.remove('ask-ai-open');
  }, [open]);

  // Picks the screen up again when the page changes under an open panel;
  // the short wait lets the new page render first.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(refresh, 400);
    setNote(null);
    return () => window.clearTimeout(t);
  }, [open, pathname, searchParams, refresh]);

  const shared = (): ScreenContent => {
    const now = captureScreen();
    // Keeps the person's trimmed text when the page has not changed.
    const text =
      screen && screen.path === now.path && screen.text !== undefined ? screen.text : now.text;
    const s = { ...now, text };
    setScreen(s);
    return { ...s, text: includeText ? s.text : undefined };
  };

  async function send() {
    const question = draft.trim();
    if (!question || busy) return;
    setError(null);
    const history = [...turns, { role: 'user' as const, content: question }];
    setTurns(history);
    setDraft('');
    setBusy(true);
    try {
      const res = await fetch('/api/v1/ask-ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          turns: history
            .slice(-MAX_CHAT_TURNS)
            .map((t) => ({ role: t.role, content: t.content.slice(0, MAX_CHAT_MESSAGE) })),
          screen: shared(),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        reply?: string;
        steps?: Turn['steps'];
        error?: { message?: string };
      } | null;
      if (!res.ok || typeof body?.reply !== 'string') {
        throw new Error(body?.error?.message ?? 'The agent did not answer. Try again.');
      }
      setTurns([...history, { role: 'assistant', content: body.reply, steps: body.steps ?? [] }]);
    } catch (err) {
      // The question goes back in the box, so nothing typed is lost.
      setTurns(turns);
      setDraft(question);
      setError(err instanceof Error ? err.message : 'The agent did not answer. Try again.');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function askInTab() {
    const question = draft.trim();
    if (!question || agent.kind !== 'link') return;
    setError(null);
    // Opened now, while the click still counts, so pop-up blockers allow it.
    const win = window.open('about:blank', '_blank');
    try {
      const content = shared();
      let code: string | undefined;
      if (agent.connected) {
        const res = await fetch('/api/v1/screen-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, content }),
        });
        const body = (await res.json().catch(() => null)) as { code?: string } | null;
        code = body?.code;
      }
      const url = askLink(
        { id: agent.name, label: agent.name, askUrl: agent.askUrl, connected: agent.connected },
        buildPrompt({ question, content, code, inlineTextMax: LINK_TEXT_MAX }),
      );
      if (win) {
        win.opener = null;
        win.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener');
      }
      setNote(`${agent.name} opened in a new tab with your question. Send it there.`);
      setDraft('');
    } catch {
      win?.close();
      setError(`${agent.name} could not be opened. Try again.`);
    }
  }

  if (!open) return null;
  const textLength = screen?.text?.length ?? 0;
  const label = agent.kind === 'chat' ? agent.label : agent.kind === 'link' ? agent.name : 'AI';

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
          <AskAiIcon /> Ask {label}
        </h2>
        <div className="flex items-center gap-2">
          {agent.kind === 'chat' && turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setTurns([]);
                setError(null);
              }}
              className="rounded-md px-2 py-1 text-sm text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              New chat
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md border border-line px-2 py-1 text-sm hover:bg-surface-2"
          >
            Close<span className="sr-only"> Ask AI</span>
          </button>
        </div>
      </div>

      {agent.kind === 'none' ? (
        <div className="space-y-3 px-4 py-4 text-sm">
          <p>Choose the AI agent you want to talk to here.</p>
          <p className="text-ink-muted">
            Claude on your claude.ai plan or Muse opens in its own tab with your question and this
            screen filled in. An agent with an API key chats with you right here.
          </p>
          <Link href="/settings/ai-agents#ask-ai" className="font-medium underline">
            Choose your agent in Settings › AI agents
          </Link>
        </div>
      ) : (
        <>
          <div
            className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
            aria-live="polite"
            aria-label="Conversation"
          >
            {agent.kind === 'chat' && turns.length === 0 && (
              <p className="text-sm text-ink-muted">
                Ask {agent.label} about this screen: a strategy, a back test, a theory or the
                screener. It sees the page and can look things up in your account.
              </p>
            )}
            {agent.kind === 'link' && (
              <p className="text-sm text-ink-muted">
                Ask {agent.name} opens {agent.name} in a new tab with your question and this screen
                filled in, and the answer appears there.
                {agent.connected ? (
                  <> {agent.name} reads the whole screen through your Trading Magician connector.</>
                ) : (
                  <>
                    {' '}
                    <Link href="/settings/ai-agents" className="underline">
                      Connect {agent.name}
                    </Link>{' '}
                    so it can read the whole screen.
                  </>
                )}
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={t.role === 'user' ? 'flex justify-end' : ''}>
                <div
                  className={
                    t.role === 'user'
                      ? 'max-w-[85%] rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap text-white'
                      : 'text-prose rounded-lg bg-surface-2 px-3 py-2 text-sm whitespace-pre-wrap'
                  }
                >
                  {t.content}
                  {t.steps && t.steps.length > 0 && (
                    <span className="mt-2 block text-xs text-ink-muted">
                      {[...new Set(t.steps.map((s) => TOOL_WORDS[s.tool] ?? s.tool))].join(', ')}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <p className="text-sm text-ink-muted" role="status">
                {agent.kind === 'chat' ? agent.label : 'The agent'} is thinking…
              </p>
            )}
            {error && <p className="rounded-md bg-surface-2 p-3 text-sm text-danger">{error}</p>}
            {note && <p className="rounded-md bg-surface-2 p-3 text-sm">{note}</p>}
            <div ref={endRef} />
          </div>

          <form
            className="space-y-2 border-t border-line px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void (agent.kind === 'chat' ? send() : askInTab());
            }}
          >
            <div className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
              <span>Sees:</span>
              <span className="max-w-[60%] truncate font-medium text-ink" title={screen?.title}>
                {screen?.heading ?? screen?.title ?? 'this page'}
              </span>
              {screen?.focus.map((f) => (
                <span
                  key={`${f.kind}:${f.ref}`}
                  className="rounded-full border border-line px-2 py-0.5"
                >
                  {FOCUS_LABEL[f.kind]} <span className="text-content">{f.ref}</span>
                </span>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={includeText}
                onChange={(e) => setIncludeText(e.target.checked)}
              />
              Include the text on this page ({textLength.toLocaleString()} characters)
            </label>
            <textarea
              ref={inputRef}
              aria-label={`Message to ${label}`}
              value={draft}
              maxLength={MAX_CHAT_MESSAGE}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void (agent.kind === 'chat' ? send() : askInTab());
                }
              }}
              placeholder={
                agent.kind === 'chat'
                  ? 'Ask about this screen… (Enter sends, Shift+Enter for a new line)'
                  : `Your question for ${label}`
              }
              className="h-20 w-full rounded-md border border-line bg-surface p-2 text-sm"
            />
            <Button type="submit" variant="primary" disabled={busy || !draft.trim()}>
              {agent.kind === 'chat' ? 'Send' : `Ask ${label}`}
            </Button>
          </form>
        </>
      )}
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
