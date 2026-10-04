import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createDemoHistoryProvider } from './demo-history';
import { createDemoLiveFeed } from './demo-live';

const A = { instrumentId: 'a', symbol: 'DEMO-A' };
const feedAt = (iso: string) => createDemoLiveFeed({ now: () => new Date(iso) });

describe('demo live feed', () => {
  it('quotes during the session with a spread around the last price', async () => {
    const q = await feedAt('2026-10-06T15:12:34.567Z').latestQuote(A);
    expect(q).toBeDefined();
    expect(q!.marketOpen).toBe(true);
    expect(q!.at).toBe('2026-10-06T15:12:34.000Z');
    expect(q!.receivedAt).toBe('2026-10-06T15:12:34.567Z');
    expect(q!.bid.lt(q!.last) && q!.ask.gt(q!.last)).toBe(true);
    expect(q!.size.gt(0)).toBe(true);
  });

  it('agrees with the hourly bars: opens at the open, ends at the close, stays in range', async () => {
    const history = createDemoHistoryProvider({ now: () => new Date('2026-10-07T00:00:00Z') });
    const { bars } = await history.getBars({
      instrumentId: 'a',
      symbol: 'DEMO-A',
      assetClass: 'stock',
      interval: '1h',
      from: '2026-10-06',
      to: '2026-10-06',
      adjustment: 'none',
      session: 'regular',
    });
    expect(bars.length).toBeGreaterThan(5);
    for (const bar of bars) {
      const open = await feedAt(bar.start).latestQuote(A);
      expect(open!.last.toString()).toBe(bar.open.toString());
      for (let m = 1; m < 60; m += 7) {
        const iso = new Date(Date.parse(bar.start) + m * 60_000).toISOString();
        const q = await feedAt(iso).latestQuote(A);
        expect(q!.last.gte(bar.low) && q!.last.lte(bar.high), `${iso} in range`).toBe(true);
      }
    }
    const last = bars.at(-1)!;
    const after = await feedAt('2026-10-06T22:00:00Z').latestQuote(A);
    expect(after!.marketOpen).toBe(false);
    expect(after!.last.toString()).toBe(last.close.toString());
    expect(after!.at).toBe(last.end);
  });

  it('holds the Friday close over a weekend and a holiday', async () => {
    const fri = await feedAt('2026-11-27T19:00:00Z').latestQuote(A); // early close day after Thanksgiving
    const sat = await feedAt('2026-11-28T15:00:00Z').latestQuote(A);
    expect(sat!.marketOpen).toBe(false);
    expect(Date.parse(sat!.at)).toBeLessThanOrEqual(Date.parse('2026-11-27T18:00:00Z'));
    expect(fri!.marketOpen).toBe(false);
    const holiday = await feedAt('2026-11-26T16:00:00Z').latestQuote(A); // Thanksgiving
    expect(holiday!.marketOpen).toBe(false);
  });

  it('is deterministic and ignores unknown symbols', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 6 * 3_600_000 }), async (ms) => {
        const iso = new Date(Date.parse('2026-10-06T13:30:00Z') + ms).toISOString();
        const [x, y] = await Promise.all([feedAt(iso).latestQuote(A), feedAt(iso).latestQuote(A)]);
        expect(x!.last.toString()).toBe(y!.last.toString());
      }),
      { numRuns: 50 },
    );
    expect(
      await feedAt('2026-10-06T15:00:00Z').latestQuote({ instrumentId: 'x', symbol: 'NOPE' }),
    ).toBeUndefined();
  });
});
