import { describe, expect, it } from 'vitest';
import {
  askLink,
  askTargets,
  buildPrompt,
  focusFromUrl,
  saveSnapshotRequest,
  tidyText,
  type ScreenContent,
} from './ask-ai';

const screen: ScreenContent = {
  title: 'Strategy Lab · Trading Magician',
  heading: 'Earnings breakout (test)',
  path: '/strategy-lab/2bce859c',
  url: 'https://app.example/strategy-lab/2bce859c',
  focus: [{ kind: 'strategy', ref: '2bce859c' }],
  text: 'Back test\n\n\n\nReturn +4.2%   \nTrades 12',
  capturedAt: '2026-11-13T18:00:00.000Z',
};

describe('focusFromUrl', () => {
  it('reads the strategy, theory, pattern and scan from the path', () => {
    expect(focusFromUrl('/strategy-lab/abc', '').focus).toEqual([{ kind: 'strategy', ref: 'abc' }]);
    expect(focusFromUrl('/library/T00012-SD', '').focus).toEqual([
      { kind: 'theory', ref: 'T00012-SD' },
    ]);
    expect(focusFromUrl('/library/new', '').focus).toEqual([]);
    expect(focusFromUrl('/research/patterns/p1', '').focus).toEqual([
      { kind: 'pattern', ref: 'p1' },
    ]);
    expect(focusFromUrl('/research/patterns/scans/s1', '').focus).toEqual([
      { kind: 'scan', ref: 's1' },
    ]);
  });

  it('reads symbols as focus and other query values as filters', () => {
    const { focus, filters } = focusFromUrl('/research', '?symbol=AAPL&compare=MSFT&range=1Y&x=');
    expect(focus).toEqual([{ kind: 'symbol', ref: 'AAPL' }]);
    expect(filters).toEqual({ compare: 'MSFT', range: '1Y' });
  });
});

describe('askTargets', () => {
  it('lists agents that open with a prompt, connected first, then Copy prompt', () => {
    const targets = askTargets(['chatgpt']);
    expect(targets.map((t) => t.id)).toEqual(['chatgpt', 'muse', 'claude', 'copy']);
    expect(targets[0]).toMatchObject({ connected: true, askUrl: 'https://chatgpt.com/?q=' });
    expect(targets.find((t) => t.id === 'muse')).toMatchObject({
      connected: false,
      askUrl: 'https://muse.ai/?prompt=',
    });
  });
});

describe('buildPrompt', () => {
  it('gives a connected agent the question and the snapshot code, not the page text', () => {
    const prompt = buildPrompt({
      question: 'Why so few trades?',
      content: screen,
      code: 'K7Q2MX9A',
    });
    expect(prompt).toContain('Why so few trades?');
    expect(prompt).toContain('get_screen_context, code K7Q2MX9A');
    expect(prompt).toContain('Earnings breakout (test)');
    expect(prompt).toContain('Strategy 2bce859c');
    expect(prompt).not.toContain('Return +4.2%');
  });

  it('writes the screen into the prompt for an agent that is not connected', () => {
    const prompt = buildPrompt({ question: 'Why?', content: screen });
    expect(prompt).toContain('Page: Earnings breakout (test) · Strategy Lab');
    expect(prompt).toContain('About: Strategy 2bce859c');
    expect(prompt).toContain('Back test\n\nReturn +4.2%\nTrades 12');
    expect(prompt).not.toContain('get_screen_context');
  });

  it('caps the page text written into a prompt', () => {
    const long = { ...screen, text: 'x'.repeat(5000) };
    const prompt = buildPrompt({ question: 'Q', content: long, inlineTextMax: 100 });
    expect(prompt).toContain(`${'x'.repeat(99)}…`);
    expect(prompt).not.toContain('x'.repeat(100));
  });

  it('builds the agent link with the prompt encoded', () => {
    const [muse] = askTargets([]).filter((t) => t.id === 'muse');
    expect(askLink(muse!, 'a b&c')).toBe('https://muse.ai/?prompt=a%20b%26c');
  });
});

describe('tidyText', () => {
  it('drops trailing spaces and runs of blank lines', () => {
    expect(tidyText('a  \n\n\n\nb\n')).toBe('a\n\nb');
  });
});

describe('saveSnapshotRequest', () => {
  it('takes a question and a screen and refuses an empty question', () => {
    expect(saveSnapshotRequest.safeParse({ question: 'Hi', content: screen }).success).toBe(true);
    expect(saveSnapshotRequest.safeParse({ question: '  ', content: screen }).success).toBe(false);
  });
});
