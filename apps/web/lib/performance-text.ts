import type { PerformanceSummaryDto } from '@tm/contracts';
import { formatMoney, formatPct, formatSignedMoney, type MetricTile } from './backtest-text';

/**
 * Words and figures for the Performance tab (Design v1.0 §10.2, §15.3;
 * ADR 0021). Every figure here comes from the API; nothing is recalculated.
 */

export interface PerformanceFilters {
  from?: string | undefined;
  to?: string | undefined;
  accountId?: string | undefined;
  strategyId?: string | undefined;
  versionId?: string | undefined;
  assetClass?: string | undefined;
  mode: 'paper' | 'live';
}

/** URL parameter for each filter, so a view can be bookmarked or linked from a notification. */
export const PERFORMANCE_PARAMS = {
  from: 'from',
  to: 'to',
  accountId: 'account',
  strategyId: 'strategy',
  versionId: 'version',
  assetClass: 'class',
  mode: 'mode',
} as const satisfies Record<keyof PerformanceFilters, string>;

export function performanceSearch(f: PerformanceFilters): string {
  const params = new URLSearchParams();
  for (const [key, param] of Object.entries(PERFORMANCE_PARAMS) as [
    keyof PerformanceFilters,
    string,
  ][]) {
    const value = f[key];
    if (value && !(key === 'mode' && value === 'paper')) params.set(param, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const ASSET_CLASS_LABELS: Record<string, string> = {
  stock: 'Stocks',
  etf: 'ETFs',
  option: 'Options',
  future: 'Futures',
  forex: 'Forex',
  crypto: 'Crypto',
};

/** The §10.2 headline numbers. */
export function performanceTiles(s: PerformanceSummaryDto): MetricTile[] {
  const t = s.trades;
  const tiles: MetricTile[] = [
    {
      label: 'Net P/L',
      value: formatSignedMoney(s.pnl.net),
      detail: `Gross ${formatSignedMoney(s.pnl.gross)}, fees ${formatMoney(s.pnl.fees)}`,
    },
    {
      label: 'Realized / unrealized',
      value: `${formatSignedMoney(s.pnl.realized)} / ${formatSignedMoney(s.pnl.unrealized)}`,
    },
  ];
  if (s.filtered) {
    tiles.push({
      label: 'Return on peak capital',
      value: formatPct(s.returnOnPeakCapitalPct, true),
      detail: `Peak capital ${formatMoney(s.peakCapital)}`,
    });
  } else {
    const app = s.equity.end;
    const broker = s.equity.brokerEnd;
    if (app || broker) {
      const differs = app && broker && Math.abs(Number(broker) - Number(app)) > 1;
      tiles.push({
        label: 'Equity',
        // Where the broker reports equity, its figure is the one that counts (§10.2).
        value: formatMoney(broker ?? app ?? 0),
        detail: !broker
          ? "From the app's ledger"
          : differs
            ? `Broker's figure; the app works out ${formatMoney(app ?? 0)}`
            : 'The broker and the app agree',
      });
    }
    tiles.push(
      {
        label: 'Return',
        value: formatPct(s.equity.returnPct, true),
        detail:
          s.equity.start && s.equity.end
            ? `Time-weighted; equity ${formatMoney(s.equity.start)} to ${formatMoney(s.equity.end)}`
            : 'Time-weighted',
      },
      {
        label: 'Max drawdown',
        value: formatPct(s.equity.maxDrawdownPct),
        ...(s.shortHistory ? { detail: 'Fewer than 20 sessions' } : {}),
      },
    );
  }
  tiles.push(
    {
      label: 'Win rate',
      value: formatPct(t.winRatePct),
      detail: `${t.wins} won, ${t.losses} lost of ${t.closed} closed`,
    },
    {
      label: 'Average gain / loss',
      value: `${t.averageWin ? formatSignedMoney(t.averageWin) : '—'} / ${t.averageLoss ? formatSignedMoney(t.averageLoss) : '—'}`,
    },
    { label: 'Profit factor', value: t.profitFactor ?? '—' },
    {
      label: 'Trades',
      value: String(t.count),
      detail: `${t.closed} closed, ${t.open} open`,
    },
    {
      label: 'Exposure',
      value: formatMoney(s.exposure.gross),
      ...(s.exposure.pctOfEquity
        ? { detail: `${formatPct(s.exposure.pctOfEquity)} of equity` }
        : {}),
    },
    {
      label: 'Turnover',
      value: formatMoney(s.turnover.traded),
      ...(s.turnover.pctOfEquity
        ? { detail: `${formatPct(s.turnover.pctOfEquity)} of average equity` }
        : {}),
    },
  );
  if (!s.filtered) {
    tiles.push({
      label: 'Sharpe ratio',
      value: s.equity.sharpe ?? '—',
      ...(s.equity.sharpe ? {} : { detail: 'Needs 20 sessions' }),
    });
  }
  return tiles;
}

/** One line for a holding the app and the broker disagree on. */
export function describePositionDifference(p: {
  symbol: string;
  app: string;
  broker: string;
}): string {
  const app = Number(p.app);
  const broker = Number(p.broker);
  if (app === 0) return `${p.symbol}: the broker holds ${p.broker}, all outside the app`;
  if (broker === 0) return `${p.symbol}: the app counts ${p.app}, the broker holds none`;
  const gap = broker - app;
  return `${p.symbol}: the app counts ${p.app}, the broker holds ${p.broker} (${gap > 0 ? `${gap} outside the app` : `${-gap} fewer at the broker`})`;
}
