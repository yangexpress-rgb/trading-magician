import { z } from 'zod';
import { AGENT_PROFILES, type AgentProfile } from './agents/profiles';

/**
 * The Ask AI panel (N272, ADR 0093): ask any AI agent about the screen you
 * are on. The panel captures what the page shows, saves it as a snapshot an
 * agent can read through get_screen_context, and hands the question to the
 * agent the person picks: agents with a prefill page (Muse, Claude, ChatGPT)
 * open with the prompt filled in; any other agent gets the prompt copied.
 * Nothing is sent to an agent until the person sends it there.
 */

/** The longest question the panel takes. */
export const MAX_QUESTION = 2000;
/** The most page text a snapshot keeps. */
export const MAX_PAGE_TEXT = 20_000;
/** The most page text written into a prompt itself (no connector to read the rest). */
export const MAX_INLINE_TEXT = 6000;

export const FOCUS_KINDS = ['strategy', 'theory', 'backtest', 'symbol', 'pattern', 'scan'] as const;
export type FocusKind = (typeof FOCUS_KINDS)[number];

export const screenContentSchema = z.object({
  title: z.string().trim().max(200),
  heading: z.string().trim().max(300).optional(),
  path: z.string().max(1000),
  url: z.string().max(2000),
  focus: z
    .array(z.object({ kind: z.enum(FOCUS_KINDS), ref: z.string().trim().min(1).max(80) }))
    .max(10),
  filters: z.record(z.string().max(60), z.string().max(400)).optional(),
  text: z.string().max(MAX_PAGE_TEXT).optional(),
  capturedAt: z.string().max(40),
});
export type ScreenContent = z.infer<typeof screenContentSchema>;

export const saveSnapshotRequest = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION),
  content: screenContentSchema,
});

/** Labels for focus items, as the panel and prompts show them. */
export const FOCUS_LABEL: Record<FocusKind, string> = {
  strategy: 'Strategy',
  theory: 'Theory',
  backtest: 'Back test',
  symbol: 'Symbol',
  pattern: 'Pattern',
  scan: 'Pattern scan',
};

const QUERY_FOCUS: Record<string, FocusKind> = {
  symbol: 'symbol',
  run: 'backtest',
  backtest: 'backtest',
};

/**
 * What a page is about, read from its address: the strategy, theory,
 * pattern or scan in the path, and symbol or back test query values. The
 * other query values are the page's filters.
 */
export function focusFromUrl(path: string, search: string) {
  const focus: { kind: FocusKind; ref: string }[] = [];
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const after = (seg: string) => {
    const i = parts.indexOf(seg);
    return i >= 0 ? parts[i + 1] : undefined;
  };
  const strategy = after('strategy-lab');
  if (strategy) focus.push({ kind: 'strategy', ref: strategy });
  const theory = after('library');
  if (theory && theory !== 'new') focus.push({ kind: 'theory', ref: theory });
  const scan = after('scans');
  if (scan) focus.push({ kind: 'scan', ref: scan });
  else {
    const pattern = after('patterns');
    if (pattern) focus.push({ kind: 'pattern', ref: pattern });
  }
  const filters: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    if (!value) continue;
    const kind = QUERY_FOCUS[key];
    if (kind) {
      for (const ref of value.split(',').filter(Boolean))
        focus.push({ kind, ref: ref.slice(0, 80) });
    } else if (Object.keys(filters).length < 20) {
      filters[key.slice(0, 60)] = value.slice(0, 400);
    }
  }
  return { focus: focus.slice(0, 10), filters };
}

/** Page text tidied for a prompt: no runs of blank lines or trailing spaces, capped. */
export function tidyText(text: string, max = MAX_PAGE_TEXT): string {
  const tidy = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return tidy.length > max ? `${tidy.slice(0, max - 1)}…` : tidy;
}

/** Where a question goes: an agent with a prefill page, or the clipboard. */
export interface AskTarget {
  id: string;
  label: string;
  /** The agent's prefill page; absent for Copy prompt. */
  askUrl?: string | undefined;
  /** Whether the agent is connected, so it can read the snapshot itself. */
  connected: boolean;
}

/** Copy prompt: for any agent, with the screen written into the prompt. */
export const COPY_TARGET: AskTarget = { id: 'copy', label: 'Copy prompt', connected: false };

/**
 * The panel's choices: agents with a prefill page, connected ones first,
 * then Copy prompt for any other agent.
 */
export function askTargets(
  connectedProfiles: readonly string[],
  profiles: readonly AgentProfile[] = AGENT_PROFILES,
): AskTarget[] {
  const withPage = profiles
    .filter((p) => p.askUrl)
    .map((p) => ({
      id: p.id,
      label: p.displayName,
      askUrl: p.askUrl,
      connected: connectedProfiles.includes(p.id),
    }));
  withPage.sort((a, b) => Number(b.connected) - Number(a.connected));
  return [...withPage, COPY_TARGET];
}

function describeFocus(content: ScreenContent) {
  return content.focus.map((f) => `${FOCUS_LABEL[f.kind]} ${f.ref}`).join(', ');
}

/** Where the person is, in one line. */
function whereLine(content: ScreenContent) {
  const name = content.heading && content.heading !== content.title ? `${content.heading} · ` : '';
  return `${name}${content.title} (${content.url})`;
}

/**
 * The prompt an agent receives. A connected agent gets the question and the
 * snapshot code, and reads the screen with get_screen_context; any other
 * agent gets the screen written into the prompt, with page text capped.
 */
export function buildPrompt(input: {
  question: string;
  content: ScreenContent;
  code?: string | undefined;
  inlineTextMax?: number;
}): string {
  const { question, content, code } = input;
  const focus = describeFocus(content);
  if (code) {
    return [
      question.trim(),
      '',
      `(Asked from Trading Magician. I'm looking at ${whereLine(content)}${focus ? `; ${focus}` : ''}. ` +
        `Read my screen with the Trading Magician tool get_screen_context, code ${code}.)`,
    ].join('\n');
  }
  const lines = [question.trim(), '', '--- What I am looking at in Trading Magician ---'];
  lines.push(`Page: ${whereLine(content)}`);
  if (focus) lines.push(`About: ${focus}`);
  const filters = Object.entries(content.filters ?? {});
  if (filters.length) lines.push(`Filters: ${filters.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (content.text) {
    lines.push(
      '',
      'What the page shows:',
      tidyText(content.text, input.inlineTextMax ?? MAX_INLINE_TEXT),
    );
  }
  return lines.join('\n');
}

/** The agent's page with the prompt filled in. */
export const askLink = (target: AskTarget, prompt: string) =>
  `${target.askUrl}${encodeURIComponent(prompt)}`;
