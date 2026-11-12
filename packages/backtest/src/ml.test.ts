import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  isRankingMetric,
  mlReads,
  nyDate,
  predictionDates,
  scheduleFrom,
  sequentialIds,
  validateStrategy,
  type Bar,
  type MlPrediction,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { spyBars } from './fixtures/spy-strategies';
import { inputs, loaded } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * ML prediction signals in the engine (ML brief v1 §8, §10, §12 checks 4–5):
 * a Selection group ranked by `ml.score` reads stored scores point in time,
 * leaves out members without a current score, and its cycle card names the
 * model run behind every pick.
 */

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SYMBOLS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
const ids = SYMBOLS.map((_, i) => uuid(0x300 + i));
const bars = SYMBOLS.map((_, i) => spyBars(700, 31 + i * 13));
const INSTRUMENTS = new Map<string, InstrumentRef>(
  SYMBOLS.map((s, i) => [ids[i] as string, { symbol: s, assetClass: 'stock', lotSize: '1' }]),
);
const MODEL = 'mf-ranker-ridge';

const leg = (id: string, partial: Partial<PlannedOrder> = {}): PlannedOrder => ({
  id,
  legLabel: id,
  instrumentId: CONTEXT_INSTRUMENT_ID,
  accountId: ACCOUNT,
  side: 'buy',
  quantity: { type: 'pct_equity', value: '90', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  timing: { mode: 'immediate' },
  ...partial,
});

function rankerDefinition(count = 2): StrategyDefinition {
  const def = createDefinition(sequentialIds('d'));
  def.risk = {
    ...def.risk,
    maxOrderNotional: '1000000',
    maxStrategyExposure: '1000000',
    maxActiveOrders: 50,
    dailyLossLimit: '50000',
  };
  def.trade = {
    kind: 'group',
    universe: { type: 'list', instrumentIds: ids },
    ranking: {
      metric: 'ml.score',
      params: { modelKey: MODEL },
      direction: 'desc',
      count: { type: 'fixed', value: count },
    },
    splitTotal: true,
  };
  def.entry.orders = [leg('buy-each')];
  def.exit.orders = [leg('close-each', { side: 'close' })];
  def.exit.rules = [{ kind: 'leftGroup', id: 'left' }];
  def.entry.schedule = scheduleFrom('monthEnd');
  return def;
}

const FROM = '2023-06-01';
const TO = '2025-06-30';
const dates = predictionDates('2023-01-01', '2025-06-30');

/** Deterministic scores: member k's score on date d; DDD has none at all (no value). */
const scoreOf = (k: number, d: number) => Math.sin(k * 1.7 + d * 0.9) + k * 0.01;
function predictions(until = '9999-12-31'): Map<string, Map<string, MlPrediction[]>> {
  const byId = new Map<string, MlPrediction[]>();
  ids.forEach((id, k) => {
    if (SYMBOLS[k] === 'DDD') return;
    byId.set(
      id,
      dates
        .filter((d) => d <= until)
        .map((asOf, i) => ({
          asOf,
          score: scoreOf(k, i),
          runNo: i + 1,
          trainingEnd: '2022-12-30',
        })),
    );
  });
  return new Map([[MODEL, byId]]);
}

function run(def: StrategyDefinition, ml = predictions()) {
  const data = loaded(Object.fromEntries(ids.map((id, i) => [id, bars[i] as Bar[]])));
  data.ml = ml;
  return simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs(FROM, TO),
    data,
    members: ids,
  });
}

describe('ml.score ranking (ML brief v1 §8)', () => {
  it('is a ranking metric and validates in a group ranking', () => {
    expect(isRankingMetric('ml.score')).toBe(true);
    const v = validateStrategy(rankerDefinition(), {
      instruments: new Map(
        ids.map((id, i) => [
          id,
          { symbol: SYMBOLS[i] as string, assetClass: 'stock', lotSize: '1', venue: 'NYSE' },
        ]),
      ),
      accounts: new Map([
        [
          ACCOUNT,
          {
            nickname: 'Paper',
            mode: 'paper',
            isActive: true,
            capabilities: {
              assetClasses: ['stock', 'etf'],
              orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
              timeInForce: ['day', 'gtc'],
              sides: ['buy', 'sell', 'sell_short', 'buy_to_cover'],
              extendedHours: false,
              shortSelling: true,
              fractionalQuantity: false,
              atomicMultiLeg: false,
              coverage: 'us',
            },
          },
        ],
      ]),
      hasFeed: () => true,
      now: new Date('2026-11-06T15:00:00Z'),
    });
    expect(v.errors).toEqual([]);
  });

  it('reads no bar series: signal reads stay out of the plan', () => {
    const reads = mlReads(rankerDefinition(), ids);
    expect([...reads.keys()]).toEqual([MODEL]);
    expect([...(reads.get(MODEL) ?? [])].sort()).toEqual([...ids].sort());
  });

  it("ranks by the month-end prediction dated that day, leaving a member without scores out as 'no value'", () => {
    const r = run(rankerDefinition());
    const rounds = r.selections?.rounds ?? [];
    expect(rounds.length).toBeGreaterThan(12);
    for (const round of rounds) {
      const day = nyDate(round.time);
      const i = dates.indexOf(day);
      expect(i).toBeGreaterThanOrEqual(0);
      const expected = SYMBOLS.map((s, k) => ({ s, v: s === 'DDD' ? null : scoreOf(k, i) }))
        .filter((x) => x.v !== null)
        .sort((a, b) => (b.v as number) - (a.v as number))
        .slice(0, 2)
        .map((x) => x.s)
        .sort();
      const selected = round.rows
        .filter((row) => row[3] !== null && row[3] <= 2)
        .map((row) => row[0]);
      expect(selected.sort()).toEqual(expected);
      const ddd = round.rows.find((row) => row[0] === 'DDD');
      expect(ddd?.[1]).toBeNull();
      expect(ddd?.[3]).toBeNull();
      expect(ddd?.[5]).not.toBeNull();
    }
  });

  it('names the model run behind every pick on the cycle card (brief §10)', () => {
    const r = run(rankerDefinition());
    const picks = (r.cycles ?? []).map((c) => c.pick).filter((p) => p !== undefined);
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      const i = dates.indexOf(nyDate(p.time));
      expect(p.ml).toBe(
        `ML score ${Number(scoreOf(SYMBOLS.indexOf(p.symbol), i).toFixed(4))} — model ${MODEL}, run ${i + 1}, trained through Dec 30, 2022, score dated ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${dates[i]}T12:00:00Z`))}`,
      );
    }
  });

  it('stops ranking once the latest score is over 45 days old (brief §8)', () => {
    const r = run(rankerDefinition(), predictions('2024-06-28'));
    const rounds = r.selections?.rounds ?? [];
    const after = rounds.filter((x) => nyDate(x.time) > '2024-08-12');
    expect(after.length).toBeGreaterThan(0);
    for (const round of after) expect(round.rows.every((row) => row[3] === null)).toBe(true);
    // July's month end (33 days after June 28) still reads June's scores.
    const july = rounds.find((x) => nyDate(x.time) === '2024-07-31');
    expect(july?.rows.some((row) => row[3] !== null)).toBe(true);
  });
});
