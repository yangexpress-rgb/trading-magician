import { describe, expect, it } from 'vitest';
import { regularSession } from '../market/calendar';
import { activeDealAt, dealSpread, dealStatusOn, formatDealId, type DealSignal } from './deals';
import {
  daysToNextEarnings,
  nextQuarterEnd,
  populationSd,
  releaseQuarterEnd,
  surprisePct,
  timeSeriesSue,
  type EarningsSignal,
  type QuarterEps,
} from './earnings';
import { rateOn } from './rates';
import { emptyEventData, eventPointAt, type EventData } from './signals';

/** The worked fixtures of the free data feeds brief v1 §7, asserted to the number. */

const closeOf = (d: string) => Date.parse(regularSession(d)?.close ?? '');

/** XYZ's quarters, built so the 8 prior differences are 0.10 ×4 and 0.30 ×4, then 0.25 (§7.1). */
function xyzSeries(): QuarterEps[] {
  const ends = [
    '2023-09-30', '2023-12-31', '2024-03-31', '2024-06-30',
    '2024-09-30', '2024-12-31', '2025-03-31', '2025-06-30',
    '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30',
  ];
  const eps = [1.85, 1.85, 1.85, 1.85, 1.95, 1.95, 1.95, 1.95, 2.25, 2.25, 2.25, 2.25, 2.5];
  return ends.map((quarterEnd, i) => ({ quarterEnd, eps: eps[i] as number }));
}

describe('§7.1 time-series SUE', () => {
  it('is 0.25 ÷ 0.10 = 2.50', () => {
    expect(populationSd([0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.3, 0.3])).toBeCloseTo(0.1, 12);
    expect(timeSeriesSue(xyzSeries())).toEqual({
      epsQ: 2.5,
      epsQMinus4: 2.25,
      diffSd: 0.1,
      sue: 2.5,
    });
  });

  it('is null with only 5 prior differences', () => {
    const r = timeSeriesSue(xyzSeries().slice(3));
    expect(r?.sue).toBeNull();
    expect(r?.diffSd).toBeNull();
  });

  it('is null when the 8 differences are all equal (SD 0)', () => {
    const flat = xyzSeries().map((q, i) => ({ ...q, eps: 1 + Math.floor(i / 4) * 0.1 }));
    flat[12] = { quarterEnd: '2026-09-30', eps: 1.5 };
    expect(timeSeriesSue(flat)?.sue).toBeNull();
  });

  it('fires the PEAD entry on Thursday, day 3 after a Monday release', () => {
    // Released Monday 2026-11-02 after the close; SUE 2.50.
    const release: EarningsSignal = {
      fiscalQuarterEnd: '2026-09-30',
      announcedAt: '2026-11-02T21:05:00.000Z',
      announcedDate: '2026-11-02',
      reportedEps: 2.5,
      sue: 2.5,
      surprisePct: null,
      source: 'recorded',
    };
    const data: EventData = { ...emptyEventData(), earnings: new Map([['xyz', [release]]]) };
    const days = (d: string) =>
      eventPointAt(data, 'xyz', 'earnings.days_since_earnings', closeOf(d), 100)?.value.toNumber();
    // Monday's close came before the release: nothing yet.
    expect(days('2026-11-02')).toBeUndefined();
    expect(days('2026-11-05')).toBe(3);
    const sue = eventPointAt(data, 'xyz', 'earnings.sue_ts', closeOf('2026-11-05'), 100);
    expect(sue?.value.toNumber()).toBe(2.5);
    // Entry: days ≤ 5 and SUE > 1.0.
    expect(days('2026-11-05')! <= 5 && sue!.value.toNumber() > 1).toBe(true);
    // With 5 prior differences the SUE is null, so the metric is unknown and never fires.
    const young: EventData = {
      ...data,
      earnings: new Map([['xyz', [{ ...release, sue: null }]]]),
    };
    expect(eventPointAt(young, 'xyz', 'earnings.sue_ts', closeOf('2026-11-05'), 100)).toBeUndefined();
  });

  it('works out a consensus surprise only with an estimate', () => {
    expect(surprisePct(2.5, 2.0)).toBe(0.25);
    expect(surprisePct(2.5, null)).toBeNull();
    expect(surprisePct(-1, -2)).toBe(0.5);
  });
});

describe('§7.2 deal spread', () => {
  const tgt: DealSignal = {
    dealId: formatDealId(1),
    announcedAt: '2026-10-01T11:00:00.000Z',
    offerPrice: 50,
    confidence: 'high',
    changes: [],
  };
  it('is (50.00 − 47.50) ÷ 47.50 = 0.0526', () => {
    expect(dealSpread(tgt, 47.5)).toBeCloseTo(0.0526315789, 9);
    const data: EventData = { ...emptyEventData(), deals: new Map([['tgt', [tgt]]]) };
    const p = eventPointAt(data, 'tgt', 'deals.spread_pct', closeOf('2026-10-02'), 47.5);
    expect(p?.value.toDecimalPlaces(4).toNumber()).toBe(0.0526);
    expect(p?.value.toNumber()).toBeGreaterThan(0.03);
    expect(p?.note).toBe('D00001');
  });

  it('is null, never zero, without a confirmed offer price', () => {
    expect(dealSpread({ ...tgt, offerPrice: null }, 47.5)).toBeUndefined();
    expect(dealSpread({ ...tgt, confidence: 'low' }, 47.5)).toBeUndefined();
    expect(dealSpread(undefined, 47.5)).toBeUndefined();
  });

  it('stops the day after the deal closes or is withdrawn', () => {
    const closed: DealSignal = { ...tgt, changes: [{ date: '2026-10-15', status: 'closed' }] };
    expect(dealStatusOn(closed, '2026-10-15')).toBe('announced');
    expect(dealStatusOn(closed, '2026-10-16')).toBe('closed');
    expect(activeDealAt([closed], closeOf('2026-10-15'))).toBeDefined();
    expect(activeDealAt([closed], closeOf('2026-10-16'))).toBeUndefined();
  });

  it('is unknown before the announcement', () => {
    expect(activeDealAt([tgt], closeOf('2026-09-30'))).toBeUndefined();
  });
});

describe('§7.3 T-bill hurdle', () => {
  it('reads DTB3 on or before the bar date as a fraction', () => {
    const rates = [
      { date: '2026-11-04', tbill3m: 0.0415 },
      { date: '2026-11-05', tbill3m: 0.0412 },
    ];
    expect(rateOn(rates, '2026-11-05')?.tbill3m).toBe(0.0412);
    // A day FRED has no value for (a holiday) reads the latest before it.
    expect(rateOn(rates, '2026-11-08')?.tbill3m).toBe(0.0412);
    expect(rateOn(rates, '2026-11-03')).toBeUndefined();
    const data: EventData = { ...emptyEventData(), rates };
    expect(
      eventPointAt(data, 'spy', 'rates.tbill_3m', closeOf('2026-11-05'), 600)?.value.toNumber(),
    ).toBe(0.0412);
  });
});

describe('next earnings (calendar feed only)', () => {
  const day = 86_400_000;
  it('is unknown in EDGAR-only mode', () => {
    expect(daysToNextEarnings(undefined, [], closeOf('2026-11-05'))).toBeUndefined();
  });
  it('counts calendar days to the next date the feed still lists', () => {
    const at = closeOf('2026-11-05');
    const schedule = [
      { date: '2026-11-12', firstSeenMs: at - 10 * day, lastSeenMs: at - day },
      // Listed once, then dropped by the feed: ignored.
      { date: '2026-11-09', firstSeenMs: at - 20 * day, lastSeenMs: at - 10 * day },
      // Not known yet at the bar.
      { date: '2026-11-10', firstSeenMs: at + day, lastSeenMs: at + day },
    ];
    expect(daysToNextEarnings(schedule, [], at)).toBe(7);
  });
});

describe('fiscal quarter of a release', () => {
  it('takes the latest quarter end, or the next one when its figures are not filed yet', () => {
    expect(releaseQuarterEnd(['2026-06-30', '2026-09-30'], '2026-10-30')).toBe('2026-09-30');
    expect(releaseQuarterEnd(['2026-03-31', '2026-06-30'], '2026-10-30')).toBe('2026-09-30');
    expect(nextQuarterEnd('2026-06-30')).toBe('2026-09-30');
    expect(nextQuarterEnd('2025-11-30')).toBe('2026-02-28');
  });
});
