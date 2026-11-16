import { describe, expect, it } from 'vitest';
import { formatLastView, lastViewCookie, parseLastView } from './research-last-view';

describe('last Price charts view (N279)', () => {
  it('round-trips the symbol and compared symbols', () => {
    const view = { instrumentId: 'abc-1', compare: ['def-2', 'ghi-3'] };
    expect(parseLastView(formatLastView(view))).toEqual(view);
  });

  it('keeps a symbol with nothing compared', () => {
    expect(parseLastView(formatLastView({ instrumentId: 'abc-1', compare: [] }))).toEqual({
      instrumentId: 'abc-1',
      compare: [],
    });
  });

  it('ignores missing or broken cookies', () => {
    expect(parseLastView(undefined)).toBeNull();
    expect(parseLastView('')).toBeNull();
    expect(parseLastView('%E0%A4%A')).toBeNull();
    expect(parseLastView(encodeURIComponent('|x'))).toBeNull();
  });

  it('drops duplicates, the main symbol, and anything past four compared', () => {
    const raw = encodeURIComponent('a|a,b,b,c,d,e,f');
    expect(parseLastView(raw)).toEqual({ instrumentId: 'a', compare: ['b', 'c', 'd', 'e'] });
  });

  it('scopes the cookie to the research pages', () => {
    expect(lastViewCookie({ instrumentId: 'a', compare: [] })).toContain('Path=/research');
  });
});
