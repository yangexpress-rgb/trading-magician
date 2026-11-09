import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARE_KIND_LABELS } from './share-text';

/** N180: the Library holds theories; Strategy Lab strategies stay strategies. */
const root = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [path] : [];
  });
}

/** The source with comments left out, so only what the person sees is checked. */
function visibleText(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('Library wording (N180)', () => {
  it('names Library items theories when shared', () => {
    expect(SHARE_KIND_LABELS.library).toBe('Library theory');
    expect(SHARE_KIND_LABELS.lab).toBe('Strategy Lab strategy');
  });

  it('never says Strategy Library or "a strategy" on the Library pages', () => {
    const files = [
      ...sources(join(root, 'app/(app)/(trading)/library')),
      ...sources(join(root, 'components/library')),
    ];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = visibleText(file);
      expect(text, file).not.toMatch(/Strategy Library/);
      expect(text, file).not.toMatch(
        /Register a strategy|Strategy profile|strategy that (returns|comes back)/,
      );
    }
  });
});
