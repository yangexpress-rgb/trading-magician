import {
  isTradingDay,
  nyDate,
  UnsupportedBarRequestError,
  type BarRequest,
  type HistoricalDataProvider,
  type LiveQuoteProvider,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';

/**
 * Market-data contract suites (Design v1.0 §17.4, ADR 0017). Every feed runs
 * them: the demo feed, and each real provider against its fake.
 */

export interface LiveQuoteHarness {
  provider: LiveQuoteProvider;
  instrument: { instrumentId: string; symbol: string };
  /** Moves the provider's clock. */
  setNow(at: Date): void;
}

/** Tuesday 2026-10-06, 11:00 New York, and the same evening. */
const SESSION = new Date('2026-10-06T15:00:00Z');
const EVENING = new Date('2026-10-06T22:00:00Z');

export function describeLiveQuoteContract(name: string, setup: () => Promise<LiveQuoteHarness>) {
  describe(`live quote contract: ${name}`, () => {
    it('quotes a known instrument during the session, keeping both timestamps', async () => {
      const h = await setup();
      h.setNow(SESSION);
      const q = await h.provider.latestQuote(h.instrument);
      expect(q).toBeDefined();
      expect(q!.instrumentId).toBe(h.instrument.instrumentId);
      expect(q!.symbol).toBe(h.instrument.symbol);
      expect(q!.marketOpen).toBe(true);
      expect(q!.bid.lte(q!.ask)).toBe(true);
      expect(q!.last.gt(0) && q!.size.gt(0)).toBe(true);
      expect(Date.parse(q!.at)).toBeLessThanOrEqual(Date.parse(q!.receivedAt));
      expect(q!.receivedAt).toBe(SESSION.toISOString());
      expect(q!.source.length).toBeGreaterThan(0);
    });

    it('marks quotes after the close as from a closed market', async () => {
      const h = await setup();
      h.setNow(EVENING);
      const q = await h.provider.latestQuote(h.instrument);
      expect(q?.marketOpen ?? false).toBe(false);
    });

    it('answers nothing for an instrument it does not know', async () => {
      const h = await setup();
      h.setNow(SESSION);
      expect(
        await h.provider.latestQuote({ instrumentId: 'unknown', symbol: 'NOSUCH' }),
      ).toBeUndefined();
    });
  });
}

export interface HistoryHarness {
  provider: HistoricalDataProvider;
  instrument: { instrumentId: string; symbol: string; assetClass: string };
}

export function describeHistoryContract(name: string, setup: () => Promise<HistoryHarness>) {
  const request = (h: HistoryHarness, patch: Partial<BarRequest> = {}): BarRequest => ({
    ...h.instrument,
    interval: '1d',
    from: '2026-09-01',
    to: '2026-09-30',
    adjustment: 'none',
    session: 'regular',
    ...patch,
  });

  describe(`history contract: ${name}`, () => {
    it('returns one ordered, well-formed daily bar per trading day in range', async () => {
      const h = await setup();
      const { bars, dataVersion } = await h.provider.getBars(request(h));
      expect(dataVersion.length).toBeGreaterThan(0);
      expect(bars.map((b) => nyDate(b.start))).toEqual(
        [...new Set(bars.map((b) => nyDate(b.start)))].sort(),
      );
      expect(bars.length).toBe(21);
      for (const b of bars) {
        const day = nyDate(b.start);
        expect(isTradingDay(day)).toBe(true);
        expect(day >= '2026-09-01' && day <= '2026-09-30').toBe(true);
        expect(Date.parse(b.end)).toBeGreaterThan(Date.parse(b.start));
        expect(b.high.gte(b.open) && b.high.gte(b.close)).toBe(true);
        expect(b.low.lte(b.open) && b.low.lte(b.close) && b.low.gt(0)).toBe(true);
      }
    });

    it('returns hourly bars inside the regular session', async () => {
      const h = await setup();
      const { bars } = await h.provider.getBars(
        request(h, { interval: '1h', from: '2026-09-15', to: '2026-09-15' }),
      );
      expect(bars.length).toBeGreaterThanOrEqual(6);
      expect(bars[0]!.start).toBe('2026-09-15T13:30:00.000Z');
      expect(bars.at(-1)!.end).toBe('2026-09-15T20:00:00.000Z');
    });

    it('gives the same data and version for the same request', async () => {
      const h = await setup();
      const a = await h.provider.getBars(request(h));
      const b = await h.provider.getBars(request(h));
      expect(b.dataVersion).toBe(a.dataVersion);
      expect(b.bars).toEqual(a.bars);
    });

    it('refuses intervals it does not offer and reversed ranges', async () => {
      const h = await setup();
      const missing = (['1m', '5m', '15m', '30m', '4h', '1w'] as const).find(
        (i) => !h.provider.intervals.includes(i),
      );
      if (missing) {
        await expect(h.provider.getBars(request(h, { interval: missing }))).rejects.toBeInstanceOf(
          UnsupportedBarRequestError,
        );
      }
      await expect(
        h.provider.getBars(request(h, { from: '2026-09-30', to: '2026-09-01' })),
      ).rejects.toBeInstanceOf(UnsupportedBarRequestError);
    });
  });
}
