import { describe, expect, it } from 'vitest';
import { scanParts } from '../src/mining';

/** A big scan result goes up in parts (N350): no part over the size, nothing lost or repeated. */
describe('scanParts', () => {
  const pattern = (id: string, n: number) => ({
    id,
    occurrences: Array.from({ length: n }, (_, i) => `${id}-${i}`),
  });

  it('keeps a small scan in one part', () => {
    const parts = scanParts([pattern('a', 3), pattern('b', 0)], 10);
    expect(parts).toEqual([[pattern('a', 3), pattern('b', 0)]]);
  });

  it('gives an empty scan one empty part, so its outcome still goes up', () => {
    expect(scanParts([], 10)).toEqual([[]]);
  });

  it('splits occurrences across parts, repeating a pattern with each of its slices', () => {
    const patterns = [pattern('a', 7), pattern('b', 0), pattern('c', 12), pattern('d', 1)];
    const parts = scanParts(patterns, 5);
    for (const part of parts)
      expect(part.reduce((n, p) => n + p.occurrences.length, 0)).toBeLessThanOrEqual(5);
    expect(parts.length).toBe(4);
    for (const p of patterns) {
      const slices = parts.flat().filter((q) => q.id === p.id);
      expect(slices.length).toBeGreaterThan(0);
      expect(slices.flatMap((q) => q.occurrences)).toEqual(p.occurrences);
    }
  });
});
