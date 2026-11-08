import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { DataValue, Stat } from './data-value';
import { Td, TdNumeric, Th } from './table';

type El = ReactElement<{ className?: string; children?: unknown; numeric?: boolean }>;

/** Expands function components one level at a time down to the host element. */
function host(el: El): El {
  let cur: El = el;
  while (typeof cur.type === 'function') {
    cur = (cur.type as (p: unknown) => El)(cur.props);
  }
  return cur;
}

const classes = (el: El) => (el.props.className ?? '').split(/\s+/);

describe('content and interface roles (N126–N133)', () => {
  it('TdNumeric renders a right-aligned cell with tabular figures', () => {
    const td = host(TdNumeric({ children: '+24.93%' }) as El);
    expect(td.type).toBe('td');
    expect(classes(td)).toEqual(expect.arrayContaining(['text-right', 'text-content']));
    expect(td.props.children).toBe('+24.93%');
  });

  it('a plain Td is left-aligned content', () => {
    const td = host(Td({ children: 'SPY' }) as El);
    expect(classes(td)).not.toContain('text-right');
    expect(classes(td)).toContain('text-content');
  });

  it('Th numeric sits on the right edge; a text header stays left', () => {
    expect(classes(host(Th({ children: 'Net', numeric: true }) as El))).toContain('text-right');
    expect(classes(host(Th({ children: 'Net', numeric: true }) as El))).not.toContain('text-left');
    expect(classes(host(Th({ children: 'Name' }) as El))).toContain('text-left');
  });

  it('DataValue shows a missing value as a dash, never 0 or blank', () => {
    const el = host(DataValue({ label: 'IV rank', value: null }) as El);
    const [, dd] = el.props.children as El[];
    expect(isValidElement(dd)).toBe(true);
    expect(dd!.props.children).toBe('—');
    const zero = host(DataValue({ label: 'Trades', value: 0 }) as El);
    expect(((zero.props.children as El[])[1] as El).props.children).toBe(0);
  });

  it('Stat sets its single figure in text-content-strong under a muted label', () => {
    const el = host(Stat({ label: 'Net return', value: '+24.93%' }) as El);
    const [dt, dd] = el.props.children as El[];
    expect(classes(dt!)).toContain('text-ink-muted');
    expect(classes(dd!)).toContain('text-content-strong');
    expect(dd!.props.children).toBe('+24.93%');
  });

  it('styles define the content role: one colour token, tabular figures, system sans, no webfont', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const rule = (name: string) => css.match(new RegExp(`\\.${name} \\{([^}]*)\\}`))?.[1] ?? '';
    for (const name of ['text-content', 'text-content-strong']) {
      expect(rule(name)).toContain('font-variant-numeric: tabular-nums');
      expect(rule(name)).toContain('var(--font-sans)');
      expect(rule(name)).toContain('var(--tm-content)');
    }
    expect(rule('text-content')).toContain('font-weight: 500');
    expect(rule('text-content-strong')).toContain('font-weight: 600');
    // Reading text: regular weight, proportional figures, relaxed leading (N134).
    expect(rule('text-prose')).toContain('font-weight: 400');
    expect(rule('text-prose')).toContain('font-variant-numeric: normal');
    expect(rule('text-prose')).toContain('line-height: 1.625');
    expect(rule('text-prose')).toContain('var(--tm-content)');
    expect(css).not.toMatch(/@import|@font-face|fonts\.googleapis/);
    // Exactly one new colour token, with light and dark values, and no --color-content.
    expect(css.match(/--tm-content:/g)).toHaveLength(2);
    expect(css).toContain('--tm-content: #1e3a5f;');
    expect(css).toContain('--tm-content: #a9c6e8;');
    expect(css).not.toMatch(/--color-content|--font-data|--font-content/);
    expect(css).not.toMatch(/url\(/);
  });
});
