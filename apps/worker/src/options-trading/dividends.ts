import { nextOptionDividend, saveOptionDividends, type ActiveCycle } from '@tm/db';
import {
  addDays,
  BrokerRejectedError,
  BrokerUnavailableError,
  contractInWords,
  dividendExerciseLikely,
  nextTradingDay,
  nyDate,
  regularSessionOpenAt,
  type Quote,
} from '@tm/domain';
import { optionsState, type OptionPassContext } from './orders';

/**
 * The dividend watch (options brief v0.2 §7.5, ADR 0123 Phase O2). A short
 * call the day before its underlying goes ex-dividend is exercised early when
 * the dividend is worth more than what is left of its time value: the holder
 * takes the shares and the dividend, and the combo is left short shares. So
 * on that day, while the session is open, a cycle holding such a call closes
 * its combo first. The ex-dates come from the broker's corporate-action
 * announcements, read at most once a day for each underlying and kept in
 * Core (`option_dividend`).
 *
 * Returns the reason in words when the cycle should close, else undefined.
 */
export async function dividendRisk(
  ctx: OptionPassContext,
  c: ActiveCycle,
  quoteFor: (instrumentId: string) => Promise<Quote | undefined>,
): Promise<string | undefined> {
  const { work, now, tx } = ctx;
  if (!regularSessionOpenAt(now.getTime())) return undefined;
  const today = nyDate(now);
  const exDate = nextTradingDay(today);
  for (const [id, q] of c.positions) {
    const ref = work.instruments.get(id);
    const option = ref?.option;
    if (!ref || !option || !q.lt(0) || option.right !== 'call') continue;
    const underlying = work.instruments.get(option.underlyingId);
    if (!underlying) continue;
    await readDividends(ctx, option.underlyingId, underlying.symbol, today);
    const div = await nextOptionDividend(tx, option.underlyingId, exDate);
    if (!div || div.exDate !== exDate) continue;
    // Past its expiry, there is nothing to exercise.
    if (option.expiry < exDate) continue;
    const mid = (await quoteFor(id))?.last;
    const price = (await quoteFor(option.underlyingId))?.last;
    if (
      !dividendExerciseLikely({
        strike: option.strike,
        mid,
        underlyingPrice: price,
        dividend: div.cashAmount,
      })
    )
      continue;
    const words = contractInWords({
      underlying: underlying.symbol,
      strike: option.strike,
      right: option.right,
      expiry: option.expiry,
    });
    return `${underlying.symbol} goes ex-dividend ${exDate} ($${div.cashAmount} a share), and the ${words} sold in this combo has less time value left than that, so it is likely to be exercised today`;
  }
  return undefined;
}

/** Today's announcements for an underlying, read from the broker once a day. */
async function readDividends(
  ctx: OptionPassContext,
  underlyingId: string,
  symbol: string,
  today: string,
): Promise<void> {
  const state = optionsState(ctx.work);
  if (state.dividendsReadOn?.[underlyingId] === today || !ctx.broker.cashDividends) return;
  try {
    const rows = await ctx.broker.cashDividends(
      ctx.work.accountId,
      symbol,
      today,
      addDays(today, 45),
    );
    await saveOptionDividends(ctx.tx, underlyingId, today, rows);
    state.dividendsReadOn = { ...state.dividendsReadOn, [underlyingId]: today };
  } catch (e) {
    if (
      e instanceof BrokerRejectedError ||
      e instanceof BrokerUnavailableError ||
      (e instanceof Error && e.name === 'AlpacaOptionsBudgetError')
    ) {
      ctx.logger.warn({ symbol, err: e }, 'dividend announcements not read');
      return;
    }
    throw e;
  }
}
