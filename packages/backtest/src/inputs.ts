import { PRICE_ADJUSTMENTS, decimalString } from '@tm/domain';
import { z } from 'zod';

/**
 * Back-test inputs (Design v1.0 §7.1). The defaults are the ones proposed for
 * §20 #5 and #6 on 2026-10-04; every one is editable on each run.
 */

export const BACKTEST_INTERVALS = ['1d', '1h', '5m'] as const;
export type BacktestInterval = (typeof BACKTEST_INTERVALS)[number];

/**
 * Longest range per run, in days (§20 #5): five years of daily bars, one of
 * hourly, one month of 5-minute (N178, ADR 0063). A month of 5-minute bars is
 * about as many bars per instrument as a year of hourly ones (some 1,700), and
 * one Alpaca page (10,000 bars) per instrument.
 */
export const MAX_RANGE_DAYS: Record<BacktestInterval, number> = {
  '1d': 5 * 366,
  '1h': 366,
  '5m': 31,
};

/** How each run interval is named in text: "Daily bars", "a daily back test". */
export const BACKTEST_INTERVAL_NAMES: Record<BacktestInterval, string> = {
  '1d': 'Daily',
  '1h': 'Hourly',
  '5m': '5-minute',
};

const RANGE_LIMIT_TEXT: Record<BacktestInterval, string> = {
  '1d': 'Daily back tests can cover at most 5 years',
  '1h': 'Hourly back tests can cover at most 1 year',
  '5m': '5-minute back tests can cover at most 31 days',
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const nonNegative = decimalString.refine((v) => Number(v) >= 0, 'Must be zero or more');

export const backtestInputsSchema = z
  .object({
    from: date,
    to: date,
    interval: z.enum(BACKTEST_INTERVALS),
    initialCapital: decimalString.refine((v) => Number(v) >= 100, 'Start with at least 100'),
    /** Price basis for fills and valuation. Conditions keep their own adjustment. */
    adjustment: z.enum(PRICE_ADJUSTMENTS),
    slippageBps: nonNegative.refine((v) => Number(v) <= 500, 'At most 500 basis points'),
    commissionPerShare: nonNegative,
    commissionMin: nonNegative,
    /** Largest share of a bar's volume one order may take; the rest fills on later bars. */
    maxVolumePct: decimalString.refine((v) => Number(v) > 0 && Number(v) <= 100, '0–100'),
    /** Annual cost of borrowing shares sold short, charged daily on their value. */
    borrowRatePct: nonNegative.refine((v) => Number(v) <= 100, 'At most 100%'),
  })
  .superRefine((v, ctx) => {
    if (v.from > v.to) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'End date must be after the start' });
      return;
    }
    const days = (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000;
    if (days > MAX_RANGE_DAYS[v.interval]) {
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: RANGE_LIMIT_TEXT[v.interval],
      });
    }
  });
export type BacktestInputs = z.infer<typeof backtestInputsSchema>;

export const DEFAULT_BACKTEST_INPUTS: Omit<BacktestInputs, 'from' | 'to'> = {
  interval: '1d',
  initialCapital: '100000',
  adjustment: 'split_and_dividend',
  slippageBps: '5',
  commissionPerShare: '0',
  commissionMin: '0',
  maxVolumePct: '10',
  borrowRatePct: '1',
};

/** The assumptions shown beside every result (§7.3). */
export function describeAssumptions(inputs: BacktestInputs): string[] {
  const commission =
    Number(inputs.commissionPerShare) === 0 && Number(inputs.commissionMin) === 0
      ? 'No commission'
      : `Commission ${inputs.commissionPerShare} per share, at least ${inputs.commissionMin} per fill`;
  return [
    `${BACKTEST_INTERVAL_NAMES[inputs.interval]} bars from ${inputs.from} to ${inputs.to}, starting with ${inputs.initialCapital}`,
    'Conditions are checked when each bar closes, using only bars that have closed',
    'Orders decided while the market is closed wait for the next regular session',
    `Market orders fill at the next bar's open with ${inputs.slippageBps} bps of slippage; stops fill at the stop or a worse open, with the same slippage`,
    'Limit orders fill at the limit, or at a better open, once a later bar trades through it',
    'Bars do not show whether the high or the low came first, so a bar that reaches both a stop and a limit is resolved by these rules',
    `Each fill takes at most ${inputs.maxVolumePct}% of a bar's volume; the rest stays working`,
    commission,
    `Short positions pay ${inputs.borrowRatePct}% a year in borrow cost; borrow is always available`,
    'Orders that would take gross exposure above account equity are rejected (no leverage)',
    `Fills and valuation use ${inputs.adjustment === 'none' ? 'unadjusted' : inputs.adjustment === 'split_only' ? 'split-adjusted' : 'split- and dividend-adjusted'} prices`,
    'An Entry condition that is already true when the test starts must turn false before it can fire',
    'Results are estimates, not guarantees',
  ];
}
