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
  exitReason?: 'condition' | 'rebalance' | 'time_stop';
  /** Two-sided strategies (v1.2 item 8): long or short, and the entry group's name. */
  direction?: 'long' | 'short';
  group?: string;
}

export interface BacktestListDto {
  runs: BacktestRunSummaryDto[];
}

export interface BacktestTradesDto {
  trades: BacktestTradeDto[];
}
