import {
  backtestInputsSchema,
  DEFAULT_BACKTEST_INPUTS,
  type BacktestInputs,
  type BacktestMetrics,
  type BacktestResult,
  type BacktestTradeLeg,
} from '@tm/backtest';
import { z } from 'zod';

/**
 * Request and response shapes for back tests (Design v1.0 §7, §14.2). Inputs
 * left out of a request take the proposed defaults (§20 #5, #6).
 */

export const startBacktestRequest = z.preprocess(
  (v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? { ...DEFAULT_BACKTEST_INPUTS, ...v } : v,
  backtestInputsSchema,
);
export type StartBacktestRequest = Partial<BacktestInputs> & Pick<BacktestInputs, 'from' | 'to'>;

export const BACKTEST_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
] as const;
export type BacktestRunStatusDto = (typeof BACKTEST_RUN_STATUSES)[number];

export interface BacktestRunSummaryDto {
  id: string;
  strategyId: string;
  versionId: string;
  versionNo: number;
  definitionHash: string;
  status: BacktestRunStatusDto;
  inputs: BacktestInputs;
  dataSource: string;
  engineVersion: string | null;
  dataVersions: string[];
  metrics: BacktestMetrics | null;
  error: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BacktestRunDto extends BacktestRunSummaryDto {
  result: Omit<BacktestResult, 'trades' | 'metrics'> | null;
}

/** Risk-based sizing of one trade (v1.2 item 9). Money and prices are decimal strings. */
export interface BacktestTradeSizingDto {
  method: 'risk_atr';
  equity: string;
  /** The amount at risk: a % of equity, or dollars (ADR 0049). */
  riskPct?: string;
  riskAmount?: string;
  atrPeriod: number;
  atr: string;
  atrMultiple: string;
  stopDistance: string;
  /** Quantity the risk budget allows before account limits. */
  riskQuantity: string;
  quantity: string;
  /** The account limit that lowered the quantity, if any. */
  cappedBy?: string;
}

export interface BacktestTradeDto {
  cycle: number;
  status: 'closed' | 'open' | 'aborted';
  entryTime: string | null;
  exitTime: string | null;
  grossPnl: string;
  costs: string;
  netPnl: string;
  returnPct: string | null;
  legs: BacktestTradeLeg[];
  /** Why the cycle exited (v1.2); absent on older runs. */
  exitReason?: 'condition' | 'rebalance' | 'time_stop' | 'atr_stop' | 'expected_move';
  /** Two-sided strategies (v1.2 item 8): long or short, and the entry group's name. */
  direction?: 'long' | 'short';
  group?: string;
  /** Risk-based sizing (v1.2 item 9): how the Entry quantity was worked out. */
  sizing?: BacktestTradeSizingDto;
  /** ATR stop (v1.2 item 9): ATR at entry, the entry price and the fixed stop level. */
  atrStop?: {
    atr: string;
    atrMultiple: string;
    direction: 'long' | 'short';
    entryPrice: string;
    level: string;
  };
  /** Expected-move exit (ADR 0053): the move captured at entry and the fixed band. */
  expectedMove?: {
    movePct: string;
    horizon: 1 | 5;
    multiple: string;
    side: 'either' | 'gain' | 'loss';
    direction: 'long' | 'short';
    entryPrice: string;
    lower: string;
    upper: string;
  };
}

export interface BacktestListDto {
  runs: BacktestRunSummaryDto[];
}

export interface BacktestTradesDto {
  trades: BacktestTradeDto[];
}
