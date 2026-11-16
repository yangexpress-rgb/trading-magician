import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import type { Quote } from '@tm/domain';
import { effectivePriceAgeSec, feedVerdict } from './feed-watch';

const NOW = new Date('2026-11-16T14:32:08Z');
const quote = (symbol: string, ageSec: number, marketOpen = true): Quote => ({
  instrumentId: `id-${symbol}`,
  symbol,
  bid: new Decimal(1),
  ask: new Decimal(1),
  last: new Decimal(1),
  size: new Decimal(1),
  at: new Date(NOW.getTime() - ageSec * 1000).toISOString(),
  receivedAt: NOW.toISOString(),
  source: 'alpaca-iex',
  marketOpen,
});
const watched = (symbol: string, q: Quote | undefined) => ({
  instrumentId: `id-${symbol}`,
  symbol,
  quote: q,
});
const base = { now: NOW, staleDataSec: 60, pauseAfterMs: 60_000, staleSince: {} };

describe('feedVerdict (N276)', () => {
  it('treats a quiet stock as current while the feed gives fresh prices', () => {
    const v = feedVerdict({
      ...base,
      prices: [watched('IT', quote('IT', 95)), watched('HOOD', quote('HOOD', 2))],
    });
    expect(v).toMatchObject({ bad: [], lost: [], feedLive: true });
  });

  it('asks the heartbeat when nothing watched moved', () => {
    const prices = [watched('FICO', quote('FICO', 120))];
    expect(feedVerdict({ ...base, prices, heartbeat: quote('SPY', 1) }).bad).toEqual([]);
    expect(feedVerdict({ ...base, prices, heartbeat: quote('SPY', 200) }).bad).toEqual(['FICO']);
    expect(feedVerdict({ ...base, prices }).bad).toEqual(['FICO']);
  });

  it('still flags a missing price, even when the feed is live', () => {
    const v = feedVerdict({
      ...base,
      prices: [watched('IT', undefined), watched('HOOD', quote('HOOD', 2))],
    });
    expect(v.bad).toEqual(['IT (no price)']);
    expect(v.staleSince).toEqual({ 'id-IT': NOW.getTime() });
  });

  it('times each instrument on its own, so one quiet stock after another does not pause', () => {
    const t = NOW.getTime();
    // FICO was stale 64 s ago and is fine now; IT has just gone missing.
    const v = feedVerdict({
      ...base,
      prices: [watched('FICO', quote('FICO', 1)), watched('IT', undefined)],
      staleSince: { 'id-FICO': t - 64_000 },
    });
    expect(v.lost).toEqual([]);
    expect(v.staleSince).toEqual({ 'id-IT': t });
  });

  it('pauses once one instrument has stayed stale for the pause time', () => {
    const t = NOW.getTime();
    const v = feedVerdict({
      ...base,
      prices: [watched('IT', undefined)],
      staleSince: { 'id-IT': t - 61_000 },
    });
    expect(v.lost).toEqual([{ symbol: 'IT', seconds: 61 }]);
  });

  it('ignores old quotes outside the session', () => {
    const v = feedVerdict({ ...base, prices: [watched('IT', quote('IT', 50_000, false))] });
    expect(v.bad).toEqual([]);
  });
});

describe('effectivePriceAgeSec', () => {
  it('counts a quote from a live feed as current', () => {
    expect(effectivePriceAgeSec(quote('IT', 95), NOW, true)).toBe(0);
    expect(effectivePriceAgeSec(quote('IT', 95), NOW, false)).toBe(95);
  });
});
