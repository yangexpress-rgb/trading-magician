import type { BacktestRunSummary, BacktestTradeRow } from '@tm/db';
import { tradeDirection } from '../backtest-text';

const HEADER = [
  'cycle',
  'status',
  'entry_time',
  'exit_time',
  'leg',
  'phase',
  'symbol',
  'side',
  'quantity',
  'average_price',
  'trade_gross_pnl',
  'trade_costs',
  'trade_net_pnl',
  'trade_return_pct',
  'strategy_version',
  'engine_version',
  'data_versions',
  'exit_reason',
  // v1.2 items 8 and 9: direction and group, and how a risk-based quantity was sized.
  'direction',
  'entry_group',
  'sizing_method',
  'sizing_equity',
  'risk_pct',
  'atr_period',
  'atr_at_entry',
  'atr_multiple',
  'stop_distance',
  'risk_quantity',
  'capped_by',
  'atr_stop_level',
  // The expected-move exit (ADR 0053): the move at entry and the band's edges.
  'expected_move_at_entry',
  'expected_move_lower',
  'expected_move_upper',
];

/**
 * One CSV cell. Quotes when needed, and defuses text a spreadsheet would run as
 * a formula. Plain numbers, including negative ones, stay numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function tradesCsv(run: BacktestRunSummary, trades: readonly BacktestTradeRow[]): string {
  const provenance = [run.versionNo, run.engineVersion, run.dataVersions.join(' ')];
  const rows: (string | number | null)[][] = [];
  for (const t of trades) {
    const trade = [t.grossPnl, t.costs, t.netPnl, t.returnPct];
    const times = [t.entryTime?.toISOString() ?? null, t.exitTime?.toISOString() ?? null];
    const legs = t.legs.length > 0 ? t.legs : [null];
    const z = t.sizing;
    const extra = [
      t.direction || t.legs.some((l) => l.side === 'sell_short') ? tradeDirection(t) : null,
      t.group ?? null,
      z?.method ?? null,
      z?.equity ?? null,
      z?.riskPct ?? null,
      z?.atrPeriod ?? null,
      z?.atr ?? null,
      z?.atrMultiple ?? null,
      z?.stopDistance ?? null,
      z?.riskQuantity ?? null,
      z?.cappedBy ?? null,
      t.atrStop?.level ?? null,
      t.expectedMove?.movePct ?? null,
      t.expectedMove?.lower ?? null,
      t.expectedMove?.upper ?? null,
    ];
    for (const l of legs) {
      rows.push([
        t.cycle,
        t.status,
        ...times,
        l?.legLabel ?? null,
        l?.phase ?? null,
        l?.symbol ?? null,
        l?.side ?? null,
        l?.quantity ?? null,
        l?.averagePrice ?? null,
        ...trade,
        ...provenance,
        t.exitReason ?? null,
        ...extra,
      ]);
    }
  }
  return [HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
