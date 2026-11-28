import { existsSync, readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import type { Bar } from '../market/bars';
import { replayMachine, type Replay } from './machine-evaluate';
import { barsResolver, S, workedExample } from './machine-fixtures';

/**
 * A3a and A3b (state-machine brief v1.4 §7, ADR 0124): the §4 worked example
 * on real QQQ daily bars. The bars are not in the repository (vendor terms;
 * Yong's choice 2026-11-28): only the expected sequences are, as facts derived
 * from them. Each test runs when its bar file is supplied and is skipped
 * otherwise:
 *
 *   A3A_QQQ_BARS=/path/qqq-2019-2020.csv A3B_QQQ_BARS=/path/qqq-2023-2025.csv \
 *     pnpm --filter @tm/domain exec vitest run machine-real-bars
 *
 * A file is CSV with a header row and the columns date (YYYY-MM-DD), open,
 * high, low, close, volume, split- and dividend-adjusted, oldest first. The
 * replay starts at the file's first bar, so the file's start is part of the
 * fixture (A3a from 2019, A3b from June 2023).
 */

function readBars(path: string): { dates: string[]; bars: Bar[] } {
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const head = (lines.shift() ?? '').toLowerCase().split(',');
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`${path}: no "${name}" column`);
    return i;
  };
  const [d, o, h, l, c, v] = ['date', 'open', 'high', 'low', 'close', 'volume'].map(col) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const dates: string[] = [];
  const bars: Bar[] = [];
  for (const line of lines) {
    const f = line.split(',');
    const date = (f[d] ?? '').slice(0, 10);
    dates.push(date);
    bars.push({
      start: `${date}T14:30:00.000Z`,
      end: `${date}T21:00:00.000Z`,
      open: new Decimal(f[o] ?? '0'),
      high: new Decimal(f[h] ?? '0'),
      low: new Decimal(f[l] ?? '0'),
      close: new Decimal(f[c] ?? '0'),
      volume: new Decimal(f[v] ?? '0'),
    } as unknown as Bar);
  }
  return { dates, bars };
}

function replayFile(path: string): { dates: string[]; replay: Replay } {
  const { dates, bars } = readBars(path);
  return { dates, replay: replayMachine(workedExample().machine, dates, barsResolver(bars)) };
}

/** The state held after the close of `on`, once that day's decision is made. */
function stateOn(replay: Replay, on: string): string {
  return replay.switches.filter((s) => s.on <= on).at(-1)?.toStateId ?? replay.startStateId;
}

const fileFor = (name: string) => {
  const path = process.env[name];
  return path && existsSync(path) ? path : undefined;
};

/** A month part as the PDF gives it: 上旬 days 1–10, 中旬 11–20, 下旬 21 to the end. */
type MonthPart = 'early' | 'mid' | 'late';
const partOf = (date: string): MonthPart => {
  const day = Number(date.slice(8, 10));
  return day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late';
};

describe('A3a: 2020 on real QQQ bars (brief §4 example)', () => {
  const path = fileFor('A3A_QQQ_BARS');

  /**
   * The PDF gives the 2020 sequence with month-part timing only, no exact
   * dates (P0 finding, 2026-11-28). The dates the P0 pack computed are
   * HI 02-19, HI_CASH 02-24, DEFEND 03-09, ATTACK_HV 04-06, NORMAL_HV 04-16,
   * NORMAL 05-12; the check is the sequence and each switch's month part.
   */
  const expected: { to: string; month: string; part: MonthPart }[] = [
    { to: S.HI, month: '2020-02', part: 'mid' },
    { to: S.HI_CASH, month: '2020-02', part: 'late' },
    { to: S.DEFEND, month: '2020-03', part: 'early' },
    { to: S.ATTACK_HV, month: '2020-04', part: 'early' },
    { to: S.NORMAL_HV, month: '2020-04', part: 'mid' },
    { to: S.NORMAL, month: '2020-05', part: 'mid' },
  ];

  it.skipIf(!path)('switches in the PDF order, each in its stated month part', () => {
    const { replay } = replayFile(path as string);
    const switches = replay.switches
      .filter((s) => s.on >= '2020-02-01' && s.on <= '2020-05-31')
      .map((s) => ({ to: s.toStateId, month: s.on.slice(0, 7), part: partOf(s.on) }));
    expect(switches).toEqual(expected);
  });

  /**
   * Late March 2020: the base rule out of DEFEND fired on Mar 26, 30, 31 and
   * Apr 2, and the anti-V lock held each time on its MA20-slope leg; release
   * came Apr 6, the first day the slope turned positive. The days count was
   * already past 3 then, so this does not test the days constant (that rests
   * on the PDF's wording under §2.1 counting and on A3c).
   */
  it.skipIf(!path)('holds DEFEND through the late-March lock, releasing on Apr 6', () => {
    const { replay } = replayFile(path as string);
    for (const on of ['2020-03-26', '2020-03-30', '2020-03-31', '2020-04-02'])
      expect(stateOn(replay, on), on).toBe(S.DEFEND);
    const release = replay.switches.find((s) => s.on > '2020-03-09' && s.fromStateId === S.DEFEND);
    expect(release).toMatchObject({ on: '2020-04-06', toStateId: S.ATTACK_HV });
  });
});

describe('A3b: Feb–Jun 2025 on real QQQ bars (provisional until Yong signs off)', () => {
  const path = fileFor('A3B_QQQ_BARS');

  /** Computed independently by the P0 pack over bars from June 2023 (2026-11-28). */
  const expected: [string, string][] = [
    ['2025-03-06', S.BEAR_CASH],
    ['2025-03-10', S.DEFEND],
    ['2025-03-24', S.BEAR_CASH],
    ['2025-03-26', S.DEFEND],
    ['2025-04-28', S.ATTACK_HV],
    ['2025-05-02', S.BEAR_CASH],
    ['2025-05-06', S.ATTACK_HV],
    ['2025-05-08', S.BEAR_CASH],
    ['2025-05-12', S.NORMAL],
  ];

  it.skipIf(!path)('starts February in NORMAL and follows the signed-off sequence', () => {
    const { dates, replay } = replayFile(path as string);
    const firstFeb = dates.find((d) => d >= '2025-02-01') as string;
    expect(stateOn(replay, firstFeb)).toBe(S.NORMAL);
    const switches = replay.switches
      .filter((s) => s.on >= '2025-02-01' && s.on <= '2025-06-30')
      .map((s) => [s.on, s.toStateId]);
    expect(switches).toEqual(expected);
    const lastJun = dates.filter((d) => d <= '2025-06-30').at(-1) as string;
    expect(stateOn(replay, lastJun)).toBe(S.NORMAL);
  });
});
