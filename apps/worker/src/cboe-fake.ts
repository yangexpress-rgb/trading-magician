import { addDays, isTradingDay, nyDate, weekday } from '@tm/domain';
import type { Fetch } from './cboe';

/**
 * Tests only (`CBOE_FAKE=true`): CBOE's history file for the VIX, made up.
 * A mean-reverting series around 19 with occasional spikes, the same every
 * time, written the way CBOE writes it (MM/DD/YYYY, OPEN/HIGH/LOW/CLOSE).
 * Each year it also has one value on Good Friday, when the NYSE is closed,
 * and lacks the first trading day of June, so the calendar alignment and the
 * "most recent close on or before" join are exercised.
 */

export const FAKE_CBOE_START = '1990-01-02';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const us = (date: string) => `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`;

/** The fake VIX history up to and including `to`. */
export function fakeVixHistory(to: string): string {
  const rand = mulberry32(0x5f1c3b);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const rows = ['DATE,OPEN,HIGH,LOW,CLOSE'];
  let x = Math.log(19);
  let skippedJune = '';
  for (let d = FAKE_CBOE_START; d <= to; d = addDays(d, 1)) {
    const wd = weekday(d);
    if (wd === 0 || wd === 6) continue;
    const trading = isTradingDay(d);
    // Good Friday: a value on a day the NYSE is closed.
    const goodFriday = !trading && wd === 5 && Number(d.slice(5, 7)) <= 4;
    if (!trading && !goodFriday) continue;
    const year = d.slice(0, 4);
    if (trading && d.slice(5, 7) === '06' && skippedJune !== year) {
      skippedJune = year;
      continue;
    }
    const spike = rand() < 0.01 ? 0.35 : 0;
    const open = Math.exp(x);
    x = x + 0.06 * (Math.log(19) - x) + 0.07 * gauss() + spike;
    const close = Math.exp(x);
    const high = Math.max(open, close) * (1 + 0.03 * rand());
    const low = Math.min(open, close) * (1 - 0.03 * rand());
    rows.push(
      [us(d), open, high, low, close]
        .map((v) => (typeof v === 'number' ? v.toFixed(2) : v))
        .join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}

/** A fetch that answers CBOE's VIX history URL with the fake file. */
export function fakeCboeFetch(now: () => Date): Fetch {
  return async (url) => {
    if (!url.endsWith('/VIX_History.csv')) return new Response('Not found', { status: 404 });
    return new Response(fakeVixHistory(nyDate(now())), {
      status: 200,
      headers: { 'content-type': 'text/csv' },
    });
  };
}
