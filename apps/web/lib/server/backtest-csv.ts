import type { BacktestRunSummary, BacktestTradeRow } from '@tm/db';

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
      ]);
    }
  }
  return [HEADER, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
