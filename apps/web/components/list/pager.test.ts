import { describe, expect, it } from 'vitest';
import { pageCount, pageFrom, pageList } from './pager';

describe('pager (N398)', () => {
  it('reads the page parameter, falling back to 1', () => {
    expect(pageFrom('3')).toBe(3);
    expect(pageFrom(undefined)).toBe(1);
    expect(pageFrom('0')).toBe(1);
    expect(pageFrom('-2')).toBe(1);
    expect(pageFrom('1.5')).toBe(1);
    expect(pageFrom('abc')).toBe(1);
  });

  it('counts pages of 50, at least one', () => {
    expect(pageCount(0)).toBe(1);
    expect(pageCount(50)).toBe(1);
    expect(pageCount(51)).toBe(2);
    expect(pageCount(64)).toBe(2);
  });

  it('lists every page when there are few', () => {
    expect(pageList(1, 2)).toEqual([1, 2]);
    expect(pageList(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips pages far from the current one with a gap', () => {
    expect(pageList(1, 20)).toEqual([1, 2, null, 20]);
    expect(pageList(10, 20)).toEqual([1, null, 9, 10, 11, null, 20]);
    expect(pageList(20, 20)).toEqual([1, null, 19, 20]);
    // A single skipped page shows as its number, not a gap.
    expect(pageList(4, 20)).toEqual([1, 2, 3, 4, 5, null, 20]);
  });
});
