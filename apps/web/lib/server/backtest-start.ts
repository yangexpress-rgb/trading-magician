import type { BacktestInputs } from '@tm/backtest';
import { startBacktest, type Transaction } from '@tm/db';
import { addDays, nyDate } from '@tm/domain';
import { DEMO_HISTORY_START } from '@tm/market-data';
import { HttpError } from './api-errors';

/**
 * Queues a back test of a strategy's current draft (§7, §14.2) after the
 * date checks the run form relies on. The Back test panel's route and the
 * agent tool `run_backtest` (ADR 0092) both start runs here.
 */
export async function queueBacktest(
  tx: Transaction,
  userId: string,
  strategyId: string,
  asked: BacktestInputs,
  now = new Date(),
) {
  const today = nyDate(now.toISOString());
  if (asked.to > today) {
    throw new HttpError('bad_request', 'Some fields need attention', [
      { path: ['to'], message: 'Choose today or an earlier date' },
    ]);
  }
  // Today's bars are still forming (N234): a run that ends today reads up to yesterday's close.
  const inputs =
    asked.to === today
      ? {
          ...asked,
          to: addDays(today, -1),
          from: asked.from > addDays(today, -1) ? addDays(today, -1) : asked.from,
        }
      : asked;
  if (inputs.from < DEMO_HISTORY_START) {
    throw new HttpError('bad_request', 'Some fields need attention', [
      { path: ['from'], message: `Back tests start no earlier than ${DEMO_HISTORY_START}` },
    ]);
  }
  return startBacktest(tx, userId, strategyId, inputs);
}
