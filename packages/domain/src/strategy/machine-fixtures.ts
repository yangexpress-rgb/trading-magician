import Decimal from 'decimal.js';
import type { Bar } from '../market/bars';
import { indicatorSeries } from '../market/indicators';
import type { SeriesExpr, SeriesResolver } from './evaluate';
import type {
  MachineComparison,
  MachineCondition,
  MachineDefinition,
  MachineExpr,
  MachineGroup,
  MachineRow,
} from './machine-schema';
import { DEFAULT_MACHINE_EXECUTION, DEFAULT_MACHINE_RISK } from './machine-schema';
import type { ComparisonOperator, Expr } from './schema';
import type { ValidationContext } from './validate';

/**
 * Test fixtures for the state-machine form (ADR 0124): the brief v1.4 §4
 * worked example, 纳指晴雨, on QQQ and TQQQ, and a bar resolver over daily
 * bars that reads only bars up to the day evaluated. Not exported from the
 * package index; the engines' tests import it as @tm/domain/machine-fixtures.
 */

export const QQQ = '00000000-0000-4000-8000-000000000a01';
export const TQQQ = '00000000-0000-4000-8000-000000000a02';

let n = 0;
const uid = (p: string) => `${p}${++n}`;

const num = (value: string): Expr => ({ kind: 'constant', id: uid('c'), value });
const metric = (id: string, params: Record<string, number> = {}): Expr => ({
  kind: 'metric',
  id: uid('m'),
  metric: id,
  params,
  instrumentId: QQQ,
});
const daily = (field: 'open' | 'close'): Expr => ({
  kind: 'market',
  id: uid('b'),
  instrumentId: QQQ,
  field,
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});
const cmp = (
  left: MachineExpr,
  operator: ComparisonOperator,
  right: MachineExpr,
): MachineComparison => ({
  kind: 'comparison',
  id: uid('cmp'),
  left,
  operator,
  right,
});
const all = (...children: MachineCondition[]): MachineGroup => ({
  kind: 'group',
  id: uid('g'),
  op: 'and',
  negate: false,
  children,
});
const any = (...children: MachineCondition[]): MachineGroup => ({ ...all(...children), op: 'or' });
const not = (...children: MachineCondition[]): MachineGroup => ({
  ...all(...children),
  negate: true,
});
const current = (...stateIds: string[]): MachineCondition => ({
  kind: 'state_is',
  id: uid('s'),
  which: 'current',
  stateIds,
});
const ref = (rowId: string): MachineCondition => ({ kind: 'row_ref', id: uid('r'), rowId });

// The brief's names: deviation = ma_distance{200}; "close > MA200" is deviation > 0.
const above200 = () => cmp(metric('ma_distance', { period: 200 }), 'gt', num('0'));
const below200 = () => cmp(metric('ma_distance', { period: 200 }), 'lt', num('0'));
const below20 = () => cmp(metric('ma_distance', { period: 20 }), 'lt', num('0'));
const above20 = () => cmp(metric('ma_distance', { period: 20 }), 'gt', num('0'));
const atOrBelow20 = () => cmp(metric('ma_distance', { period: 20 }), 'lte', num('0'));
const atOrAbove20 = () => cmp(metric('ma_distance', { period: 20 }), 'gte', num('0'));
const slope = (op: ComparisonOperator) =>
  cmp(metric('ma_slope', { period: 20, bars: 1 }), op, num('0'));
const dd = (op: ComparisonOperator, v: string) => cmp(metric('ath_drawdown'), op, num(v));
const highVol = () => cmp(metric('volatility', { window: 20 }), 'gte', num('0.3'));

export const S = {
  HI: 'HI',
  HI_CASH: 'HI_CASH',
  TOP_ESCAPE: 'TOP_ESCAPE',
  ATTACK_HV: 'ATTACK_HV',
  DESPAIR_HV: 'DESPAIR_HV',
  NORMAL_HV: 'NORMAL_HV',
  DESPAIR: 'DESPAIR',
  ATTACK: 'ATTACK',
  NORMAL: 'NORMAL',
  DEFEND: 'DEFEND',
  BEAR_CASH: 'BEAR_CASH',
} as const;
export const RISK_OFF = [S.BEAR_CASH, S.DEFEND, S.TOP_ESCAPE];

const go = (id: string, stateId: string, condition?: MachineGroup): MachineRow => ({
  id,
  outcome: { kind: 'go', stateId },
  ...(condition ? { condition } : {}),
});

/** Brief v1.4 §4, rows 1 to 16, in order (v1.4 adds the chain-exit rows 4 and 5). */
export function workedExample(): MachineDefinition {
  const q = (weightPct: string) => [{ instrumentId: QQQ, weightPct }];
  const t = (weightPct: string) => [{ instrumentId: TQQQ, weightPct }];
  return {
    form: 'state_machine',
    machineVersion: 1,
    trade: { kind: 'signals', instrumentIds: [QQQ] },
    machine: {
      states: [
        { id: S.HI, name: 'High (deviation escape)', targets: q('99') },
        { id: S.HI_CASH, name: 'High, in cash', targets: [] },
        { id: S.TOP_ESCAPE, name: 'Top escape', targets: q('99') },
        { id: S.ATTACK_HV, name: 'Attack, high volatility', targets: [] },
        { id: S.DESPAIR_HV, name: 'Despair, high volatility', targets: [] },
        { id: S.NORMAL_HV, name: 'Normal, high volatility', targets: q('99') },
        { id: S.DESPAIR, name: 'Despair', targets: t('99') },
        { id: S.ATTACK, name: 'Attack', targets: t('99') },
        { id: S.NORMAL, name: 'Normal', targets: t('99') },
        { id: S.DEFEND, name: 'Defend', targets: q('50') },
        { id: S.BEAR_CASH, name: 'Bear, in cash', targets: [] },
      ],
      rows: [
        go('r1', S.HI, all(current(S.HI), above200(), not(below20(), slope('lt')))),
        go('r2', S.HI_CASH, all(current(S.HI), above200(), below20(), slope('lt'))),
        go('r3', S.HI_CASH, all(current(S.HI_CASH), above200(), below20())),
        // v1.4 (O263): the chain's exit, judged before the deviation escape.
        go('r4', S.NORMAL_HV, all(current(S.HI_CASH), above200(), atOrAbove20(), highVol())),
        go('r5', S.NORMAL, all(current(S.HI_CASH), above200(), atOrAbove20())),
        go(
          'r6',
          S.HI,
          all(cmp(metric('ma_distance', { period: 200 }), 'gt', num('0.2')), dd('gte', '-0.05')),
        ),
        go(
          'r7',
          S.TOP_ESCAPE,
          all(
            dd('gte', '-0.05'),
            cmp(metric('relative_volume', { window: 60 }), 'gt', num('2.2')),
            cmp(daily('close'), 'lt', daily('open')),
          ),
        ),
        {
          id: 'r8',
          outcome: { kind: 'stay' },
          condition: all(
            current(...RISK_OFF),
            any(
              cmp(
                { kind: 'days_in_states', id: uid('d'), stateIds: [...RISK_OFF] },
                'lt',
                num('3'),
              ),
              slope('lte'),
            ),
            any(ref('r13'), ref('r14')),
          ),
        },
        go('r9', S.ATTACK_HV, all(ref('r13'), highVol())),
        go('r10', S.DESPAIR_HV, all(ref('r12'), highVol())),
        go('r11', S.NORMAL_HV, all(above200(), dd('gte', '-0.1'), highVol())),
        go('r12', S.DESPAIR, all(below200(), dd('lte', '-0.3'), slope('gt'))),
        go(
          'r13',
          S.ATTACK,
          any(
            all(above200(), dd('lt', '-0.1')),
            all(below200(), dd('gt', '-0.3'), dd('lte', '-0.1'), above20()),
          ),
        ),
        go('r14', S.NORMAL, all(above200(), dd('gte', '-0.1'))),
        go('r15', S.DEFEND, all(below200(), dd('gt', '-0.3'), dd('lte', '-0.1'), atOrBelow20())),
        go('r16', S.BEAR_CASH),
      ],
    },
    execution: { ...DEFAULT_MACHINE_EXECUTION },
    risk: { ...DEFAULT_MACHINE_RISK },
  };
}

export const machineContext = (): ValidationContext => ({
  instruments: new Map([
    [QQQ, { symbol: 'QQQ', assetClass: 'etf', lotSize: '1' }],
    [TQQQ, { symbol: 'TQQQ', assetClass: 'etf', lotSize: '1' }],
  ]),
  accounts: new Map(),
  hasFeed: () => true,
  now: new Date('2026-11-27T21:00:00Z'),
});

export interface Day {
  open: number;
  close: number;
  volume: number;
}

/**
 * A seeded daily walk with regimes (rallies, crashes, chop), so the worked
 * example visits many states. Opens differ from closes for down days.
 */
export function regimeWalk(count: number, seed = 7): Day[] {
  let x = seed;
  const rand = () => (x = (x * 16807) % 2147483647) / 2147483647;
  let close = 100;
  let drift = 0.001;
  let vol = 0.012;
  return Array.from({ length: count }, (_, i) => {
    if (i % 60 === 0) {
      const r = rand();
      drift = r < 0.2 ? -0.006 : r < 0.35 ? 0.004 : r < 0.5 ? 0.008 : 0.0008;
      vol = r < 0.25 ? 0.03 : 0.012;
    }
    const open = close * (1 + (rand() - 0.5) * vol);
    close = Math.max(5, open * (1 + drift + (rand() - 0.5) * 2 * vol));
    const spike = rand() < 0.03 ? 4 : 1;
    return {
      open: Math.round(open * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(1_000_000 * (0.5 + rand()) * spike),
    };
  });
}

export const walkDates = (count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2015, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  );

/**
 * A resolver over QQQ's daily bars as of day `last`: `offset + barsBack` bars
 * before it, never after. `missing` days read as no bar.
 */
export function dayResolver(days: readonly Day[], missing: ReadonlySet<number> = new Set()) {
  const dates = walkDates(days.length);
  const bars = days.map(
    (d, i) =>
      ({
        start: `${dates[i]}T14:30:00.000Z`,
        end: `${dates[i]}T21:00:00.000Z`,
        open: new Decimal(d.open),
        high: new Decimal(Math.max(d.open, d.close)),
        low: new Decimal(Math.min(d.open, d.close)),
        close: new Decimal(d.close),
        volume: new Decimal(d.volume),
      }) as unknown as Bar,
  );
  const cache = new Map<string, (Decimal | undefined)[]>();
  return (last: number): SeriesResolver => ({
    value(expr: SeriesExpr, barsBack: number) {
      if (expr.instrumentId !== QQQ) return undefined;
      const at = last - expr.offset - barsBack;
      if (at < 0 || missing.has(at)) return undefined;
      if (expr.kind === 'market')
        return (bars[at] as unknown as Record<string, Decimal>)[expr.field];
      const key = `${expr.name}|${JSON.stringify(expr.params)}|${expr.field}`;
      if (!cache.has(key))
        cache.set(key, indicatorSeries(expr.name, expr.params, bars, expr.field));
      return cache.get(key)?.[at];
    },
    isStale: () => false,
  });
}
