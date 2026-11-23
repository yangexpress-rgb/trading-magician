import type { LiveQuoteProvider, Quote, QuoteRequest } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { feedIncidentSummary, feedVerdict } from './feed-watch';
import { missReasonOf, QuoteHub } from './quote-hub';

/** The worker's shared live prices and their incident wording (N328). */

const quote = (ref: QuoteRequest, at: string): Quote =>
  ({ instrumentId: ref.instrumentId, symbol: ref.symbol, at, marketOpen: true }) as Quote;

function batchFeed() {
  const calls: string[][] = [];
  let fail: Error | undefined;
  const source: LiveQuoteProvider = {
    id: 'test',
    latestQuote: async (ref) => quote(ref, '2026-11-23T14:32:00.000Z'),
    latestQuotes: async (refs) => {
      calls.push(refs.map((r) => r.symbol));
      if (fail) throw fail;
      return new Map(refs.map((r) => [r.instrumentId, quote(r, '2026-11-23T14:32:00.000Z')]));
    },
  };
  return { source, calls, setFail: (e: Error | undefined) => (fail = e) };
}

const SPY = { instrumentId: 'i-spy', symbol: 'SPY' };
const QQQ = { instrumentId: 'i-qqq', symbol: 'QQQ' };
const TLT = { instrumentId: 'i-tlt', symbol: 'TLT' };

const throttled = () => {
  const e = new Error('Alpaca is over its request limit for this key');
  e.name = 'AlpacaRateLimitError';
  return e;
};

describe('the quote hub', () => {
  it('serves every runtime from one request while prices are fresh', async () => {
    const feed = batchFeed();
    const hub = new QuoteHub({ freshMs: 2_000 });
    const t = 1_000_000;
    await hub.get('f', feed.source, [SPY, QQQ], t);
    await hub.get('f', feed.source, [SPY, QQQ], t + 500);
    await hub.get('f', feed.source, [SPY], t + 1_000);
    expect(feed.calls).toEqual([['SPY', 'QQQ']]);
    // A new symbol joins the next request with everything else wanted lately.
    await hub.get('f', feed.source, [TLT], t + 2_500);
    expect(feed.calls[1]?.sort()).toEqual(['QQQ', 'SPY', 'TLT']);
  });

  it('names a refused request as throttled and asks the whole wanted set again after (A2)', async () => {
    const feed = batchFeed();
    const logs: { msg: string; obj: Record<string, unknown> }[] = [];
    const logger = {
      info: (obj: Record<string, unknown>, msg: string) => logs.push({ obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => logs.push({ obj, msg }),
    };
    const hub = new QuoteHub({ freshMs: 2_000, logger: logger as never });
    const t = 2_000_000;
    feed.setFail(throttled());
    await hub.get('f', feed.source, [SPY, QQQ], t);
    expect(hub.read('f', SPY.instrumentId)).toMatchObject({ reason: 'throttled' });
    // Failures are kept as briefly as prices, so a refused key is not asked again at once.
    await hub.get('f', feed.source, [SPY, QQQ], t + 1_000);
    expect(feed.calls).toHaveLength(1);
    feed.setFail(undefined);
    await hub.get('f', feed.source, [SPY], t + 3_000);
    expect(feed.calls[1]?.sort()).toEqual(['QQQ', 'SPY']);
    const restored = logs.find((l) => l.msg.startsWith('price feed answering again'));
    expect(restored?.obj).toMatchObject({
      event: 'quotes.feed_restored',
      reason: 'throttled',
      downForMs: 3_000,
      restored: ['SPY', 'QQQ'],
      stillMissing: [],
    });
  });

  it('tells throttling, timeouts and other failures apart', () => {
    expect(missReasonOf(throttled())).toBe('throttled');
    expect(missReasonOf(new Error('quote timed out'))).toBe('timeout');
    expect(missReasonOf(new Error('boom'))).toBe('error');
  });
});

describe('the price incident wording', () => {
  const now = new Date('2026-11-23T14:33:00.000Z');
  const verdict = (prices: Parameters<typeof feedVerdict>[0]['prices']) =>
    feedVerdict({ prices, now, staleDataSec: 60, pauseAfterMs: 60_000, staleSince: {} });

  it('says Alpaca refused the requests', () => {
    const v = verdict([
      { instrumentId: 'a', symbol: 'SPY', quote: undefined, miss: 'throttled' },
      { instrumentId: 'b', symbol: 'QQQ', quote: undefined, miss: 'throttled' },
    ]);
    expect(feedIncidentSummary(v, 60)).toBe(
      'Alpaca refused the price requests for SPY, QQQ as over the key’s request limit; no new orders are sent until they are current.',
    );
  });

  it('names a subscribed but silent symbol, which does not stop orders', () => {
    const v = verdict([
      { instrumentId: 'a', symbol: 'SPY', quote: quote(SPY, '2026-11-23T14:32:59.000Z') },
      { instrumentId: 'b', symbol: 'SVXY', quote: quote(TLT, '2026-11-23T14:31:45.000Z') },
    ]);
    expect(v.bad).toEqual([]);
    expect(v.silent).toEqual([{ symbol: 'SVXY', seconds: 75 }]);
    expect(feedIncidentSummary(v, 60)).toBe(
      'Subscribed but silent: the feed is answering but sent no new price for SVXY for 75 seconds; other prices are current, so orders still go.',
    );
  });

  it('names a feed that answered without the symbol', () => {
    const v = verdict([{ instrumentId: 'a', symbol: 'QQQ', quote: undefined, miss: 'no_reply' }]);
    expect(feedIncidentSummary(v, 60)).toMatch(
      /^Subscribed but silent: the feed answered but sent no price for QQQ; no new orders/,
    );
  });
});
