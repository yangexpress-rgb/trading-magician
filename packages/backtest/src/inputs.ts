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

/**
 * How far a run looks back from its end date (N229): the form picks an end
 * date (today by default) and one of these, and the run covers the period
 * before it. Months and years are calendar ones.
 */
export const BACKTEST_LOOKBACKS = ['1w', '2w', '1m', '3m', '6m', '1y', '2y', '3y', '5y'] as const;
export type BacktestLookback = (typeof BACKTEST_LOOKBACKS)[number];

export const BACKTEST_LOOKBACK_NAMES: Record<BacktestLookback, string> = {
  '1w': '1 week',
  '2w': '2 weeks',
  '1m': '1 month',
  '3m': '3 months',
  '6m': '6 months',
  '1y': '1 year',
  '2y': '2 years',
  '3y': '3 years',
  '5y': '5 years',
};

/** The first day of a run that ends on `to` and looks back `lookback`. */
export function lookbackStart(to: string, lookback: BacktestLookback): string {
  const [y, m, d] = to.split('-').map(Number) as [number, number, number];
  const amount = Number(lookback.slice(0, -1));
  const unit = lookback.slice(-1);
  if (unit === 'w') {
    const t = Date.UTC(y, m - 1, d) - amount * 7 * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  }
  const months = unit === 'y' ? amount * 12 : amount;
  const target = new Date(Date.UTC(y, m - 1 - months, 1));
  // The same day of the month, or the month's last day (Mar 31 → Feb 28).
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Whether a look-back fits the longest range a run interval allows. */
export function lookbackFits(
  to: string,
  lookback: BacktestLookback,
  interval: BacktestInterval,
): boolean {
  const days = (Date.parse(to) - Date.parse(lookbackStart(to, lookback))) / 86_400_000;
  return days <= MAX_RANGE_DAYS[interval];
}

/** A stock or ETF symbol as typed for a run's instruments (N230). */
export const BACKTEST_SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/;
/** Most instruments a run can be narrowed to (N230): the whole S&P 500 fits. */
export const MAX_BACKTEST_SYMBOLS = 600;
const nonNegative = decimalString.refine((v) => Number(v) >= 0, 'Must be zero or more');

export const backtestInputsSchema = z
  .object({
    from: date,
    to: date,
    /** The period the form picked, kept to describe the run (N229); from/to are what run. */
    lookback: z.enum(BACKTEST_LOOKBACKS).optional(),
    /**
     * The strategy's own bar size (N228, ADR 0079): the server sets it from
     * the rules, whatever a request sends.
     */
    interval: z.enum(BACKTEST_INTERVALS),
    /**
     * Only these members of a group are tested (N230); absent tests the whole
     * group. Symbols, upper case.
     */
    symbols: z
      .array(z.string().regex(BACKTEST_SYMBOL, 'Use a symbol such as AAPL'))
      .min(1, 'Pick at least one instrument')
      .max(MAX_BACKTEST_SYMBOLS, `At most ${MAX_BACKTEST_SYMBOLS} instruments`)
      .optional(),
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
    ...(inputs.symbols
      ? [
          `Only ${inputs.symbols.length === 1 ? 'this member' : `these ${inputs.symbols.length} members`} of the group: ${inputs.symbols.slice(0, 20).join(', ')}${inputs.symbols.length > 20 ? '…' : ''}`,
        ]
      : []),
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
