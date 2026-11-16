import type { StockScreenDataDto } from '@tm/contracts';
import {
  activeOptionsFeed,
  getStockScreenData,
  latestSignalsBySymbol,
  loadPriceRanges,
} from '@tm/db';
import {
  addDays,
  liveYearRange,
  nyDate,
  OPTION_SIGNAL_MAX_AGE_TRADING_DAYS,
  screenOptionColumns,
  screenRangeColumns,
  SCREEN_PRICE_COLUMNS,
  SCREEN_TEXT_COLUMNS,
  tradingDaysBetween,
  withScreenOptions,
  withScreenRange,
  type ScreenRowTuple,
} from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

const symbolAt = SCREEN_TEXT_COLUMNS.indexOf('symbol');
const priceAt = (c: (typeof SCREEN_PRICE_COLUMNS)[number]) =>
  SCREEN_TEXT_COLUMNS.length + SCREEN_PRICE_COLUMNS.indexOf(c);
const instrumentAt = SCREEN_TEXT_COLUMNS.length + SCREEN_PRICE_COLUMNS.length + 1;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The screen with every row: about a megabyte for the whole US market, fetched
 * once. With the options feed on, the recorded underlyings' latest daily options
 * signal fills the options columns (ADR 0048); a signal more than 5 trading days
 * old is left out, as strategies leave it out. The stored 52-week lows and
 * highs fill the 52-week columns (N290), rolled forward with the row's
 * prices for the screen's session while it trades.
 */
export const GET = api<{ screenId: string }>(async (_request, { tx }, { screenId }) =>
  Response.json(
    await tx(async (t) => {
      const data: StockScreenDataDto = await getStockScreenData(t, screenId);
      if (!data.rows) return data;
      let rows: ScreenRowTuple[] = data.rows;
      if (await activeOptionsFeed(t)) {
        const today = nyDate(new Date());
        const signals = await latestSignalsBySymbol(t, addDays(today, -14));
        if (signals.size > 0)
          rows = rows.map((row) => {
            const s = signals.get(String(row[symbolAt]));
            if (!s || tradingDaysBetween(s.date, today) > OPTION_SIGNAL_MAX_AGE_TRADING_DAYS)
              return row;
            return withScreenOptions(row, screenOptionColumns(s.values));
          });
      }
      const ranges = await loadPriceRanges(t);
      if (ranges.byId.size > 0)
        rows = rows.map((row) => {
          const id = row[instrumentAt];
          const stored =
            (typeof id === 'string' ? ranges.byId.get(id) : undefined) ??
            ranges.bySymbol.get(String(row[symbolAt]));
          if (!stored) return row;
          // A row with today's high and low traded in the screen's session.
          const low = num(row[priceAt('low')]);
          const high = num(row[priceAt('high')]);
          const today =
            data.sessionDate && low !== null && high !== null
              ? { date: data.sessionDate, low, high, last: num(row[priceAt('last')]) }
              : null;
          return withScreenRange(row, screenRangeColumns(liveYearRange(stored, today)));
        });
      return { ...data, rows };
    }),
  ),
);
