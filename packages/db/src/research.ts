import type { Database, Transaction } from './client';
import { withTenant, type TenantContext } from './tenant';

/**
 * The Research Store (ADR 0115, N331): a database of its own for the bulky
 * research data that execution never reads. The Core Store keeps everything a
 * running strategy, an order or the Orders page reads; the Research Store
 * keeps factor snapshots, raw option chains, pattern scans, patterns and occurrences,
 * ML training data and back test trades.
 *
 * Until a Research database is configured (RESEARCH_DATABASE_URL and its role
 * URLs), the same tables in the Core database answer: every caller goes
 * through a `ResearchStore`, so pointing it elsewhere is configuration only.
 */

/**
 * The tables that live in the Research Store, parents before children (the
 * order the copy command fills them). Everything else stays in Core.
 */
export const RESEARCH_TABLES = [
  'option_contract',
  'option_chain_snapshot',
  'factor_snapshot',
  'factor_coverage',
  'pattern_scan',
  'pattern',
  'pattern_occurrence',
  'ml_feature_snapshot',
  'ml_label',
  'ml_evaluation',
  'ml_report',
  'ml_frozen_as_of',
  'backtest_trade',
] as const;
export type ResearchTable = (typeof RESEARCH_TABLES)[number];

/**
 * Where research reads and writes go. `separate` is false while the Core
 * database still holds the research tables.
 */
export interface ResearchStore {
  db: Database;
  separate: boolean;
}

export function researchStore(core: Database, research?: Database): ResearchStore {
  return research ? { db: research, separate: true } : { db: core, separate: false };
}

/** Runs `fn` in a Research Store transaction scoped to one tenant. */
export function inResearchTenant<T>(
  store: ResearchStore,
  tenant: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return withTenant(store.db, tenant, fn).catch((error: unknown) => {
    throw researchUnavailable(error);
  });
}

/** A tenant-scoped runner on the Research Store, handed to functions that read both stores. */
export type ResearchTx = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

export function researchTx(store: ResearchStore, tenant: TenantContext): ResearchTx {
  return (fn) => inResearchTenant(store, tenant, fn);
}

/**
 * Raised when the Research Store can't be reached. Research features show it
 * as a plain status; trading never calls the Research Store, so it never sees it.
 */
export class ResearchUnavailableError extends Error {
  override name = 'ResearchUnavailableError';
  constructor(cause?: unknown) {
    super(
      'Research storage is not reachable right now: research results are paused. Trading is unaffected.',
      { cause },
    );
  }
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01',
  '57P03',
]);

/** A connection failure becomes a `ResearchUnavailableError`; anything else passes through. */
export function researchUnavailable(error: unknown): unknown {
  if (error instanceof ResearchUnavailableError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && CONNECTION_CODES.has(code))
    return new ResearchUnavailableError(error);
  return error;
}

/**
 * The Window Contract (ADR 0115): the market data the Core Store keeps
 * because execution reads it. Anything outside it belongs to the Research
 * Store. On 2026-11-24 the owner chose to keep the small reference data a
 * running strategy reads whole in Core for S1 (`window: 'whole'`), because
 * conditions and back tests read its full history; those tables are well
 * under 1% of the disk the research tables used.
 */
export const WINDOW_CONTRACT = [
  {
    data: 'Daily bars',
    window: '13 months',
    core: null,
    note: 'No bar store: bars come live from the price feed.',
  },
  {
    data: '5-minute bars',
    window: '35 days',
    core: null,
    note: 'No bar store: bars come live from the price feed.',
  },
  {
    data: 'Options daily signals',
    window: 'whole',
    core: ['option_daily_signal', 'option_expiry_signal'],
    note: 'Kept the options history window (OPTIONS_HISTORY_DAYS); raw chains are Research data, 90 days.',
  },
  {
    data: 'ML predictions',
    window: 'whole',
    core: ['ml_model', 'ml_model_run', 'ml_prediction'],
    note: 'Frozen Outputs; a strategy reads at most 45 days back, back tests read the history.',
  },
  {
    data: 'Earnings, deals, rates, short interest',
    window: 'whole',
    core: [
      'earnings_release',
      'earnings_calendar',
      'earnings_sue',
      'deal_event',
      'deal_filing',
      'deal_status_history',
      'rates_daily',
      'short_interest',
      'short_interest_settlement',
    ],
    note: 'Read as the latest record on or before each bar.',
  },
  {
    data: 'Company filings',
    window: 'whole',
    core: ['fundamental_company', 'fundamental_observation'],
    note: 'Fundamental metrics read the filing history (TTM, growth).',
  },
  {
    data: 'Group membership',
    window: 'whole',
    core: ['group_membership_period'],
    note: 'Point-in-time S&P 500 membership.',
  },
] as const;
