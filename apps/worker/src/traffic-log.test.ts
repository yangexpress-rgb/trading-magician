import { AlpacaRequestBudget } from '@tm/alpaca';
import type { LiveQuoteProvider, Quote } from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { createFeedAsker, drainQuoteTrail } from './routed-quotes';
import { startTrafficLog } from './traffic-log';

/** The once-a-minute Alpaca traffic and quote-ask log. */

function recorder() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
  return {
    lines,
    logger: {
      info: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'info', obj, msg }),
      warn: (obj: Record<string, unknown>, msg: string) => lines.push({ level: 'warn', obj, msg }),
    },
  };
}

describe('the traffic log', () => {
  it('warns with the key traffic when Alpaca throttled it', () => {
    const budget = new AlpacaRequestBudget();
    budget.record('KEY9', {
      host: 'data',
      route: '/v2/stocks/snapshots',
      background: false,
      status: 429,
      ms: 30,
    });
    const r = recorder();
    const log = startTrafficLog({ logger: r.logger as never, budget, everyMs: 3_600_000 });
    drainQuoteTrail();
    log.flush();
    log.stop();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({
      level: 'warn',
      msg: 'alpaca requests last minute',
      obj: { event: 'alpaca.traffic', key: 'KEY9', throttled: 1 },
    });
  });

  it('names each symbol whose quote ask failed, why, and when it last worked', async () => {
    drainQuoteTrail();
    let fail = false;
    const source: LiveQuoteProvider = {
      id: 'test',
      latestQuote: async (ref) => {
        if (fail) {
          const e = new Error('Alpaca is over its request limit for this key');
          e.name = 'AlpacaRateLimitError';
          throw e;
        }
        return {
          symbol: ref.symbol,
          instrumentId: ref.instrumentId,
          at: '2026-11-23T14:32:00.000Z',
        } as Quote;
      },
    };
    const feeds = new Map([
      ['f1', { id: 'f1', provider: 'test', isActive: true, config: {}, credentialRef: null }],
    ]);
    const askerFor = () =>
      createFeedAsker({
        tx: undefined as never,
        userId: 'u',
        now: new Date(),
        feeds: feeds as never,
        providers: { test: { needsCredential: false, quotes: () => source } } as never,
        privateKey: undefined,
        logger: { warn: () => undefined },
      });
    await askerFor().ask('f1', { instrumentId: 'i-spy', symbol: 'SPY' });
    fail = true;
    await askerFor().ask('f1', { instrumentId: 'i-spy', symbol: 'SPY' });
    await askerFor().ask('f1', { instrumentId: 'i-qqq', symbol: 'QQQ' });

    const r = recorder();
    const log = startTrafficLog({
      logger: r.logger as never,
      budget: new AlpacaRequestBudget(),
      everyMs: 3_600_000,
    });
    log.flush();
    log.stop();
    expect(r.lines).toHaveLength(1);
    const { obj } = r.lines[0]!;
    expect(r.lines[0]!.level).toBe('warn');
    expect(obj).toMatchObject({ event: 'quotes.trail', symbols: 2, asks: 3, failedAsks: 2 });
    const failed = obj.failed as { symbol: string; lastError: string; lastOkAt: string | null }[];
    expect(failed.map((f) => f.symbol)).toEqual(['QQQ', 'SPY']);
    expect(failed.every((f) => f.lastError === 'throttled')).toBe(true);
    expect(failed.find((f) => f.symbol === 'SPY')!.lastOkAt).not.toBeNull();
    expect(failed.find((f) => f.symbol === 'QQQ')!.lastOkAt).toBeNull();
  });
});
