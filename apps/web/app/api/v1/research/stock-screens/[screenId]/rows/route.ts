import type { StockScreenDataDto } from '@tm/contracts';
import { activeOptionsFeed, getStockScreenData, latestSignalsBySymbol } from '@tm/db';
import {
  addDays,
  nyDate,
  OPTION_SIGNAL_MAX_AGE_TRADING_DAYS,
  screenOptionColumns,
  SCREEN_TEXT_COLUMNS,
  tradingDaysBetween,
  withScreenOptions,
} from '@tm/domain';
import { api } from '@/lib/server/api';

export const dynamic = 'force-dynamic';

/**
 * The screen with every row: about a megabyte for the whole US market, fetched
 * once. With the options feed on, the recorded underlyings' latest daily options
 * signal fills the options columns (ADR 0048); a signal more than 5 trading days
 * old is left out, as strategies leave it out.
 */
export const GET = api<{ screenId: string }>(async (_request, { tx }, { screenId }) =>
  Response.json(
    await tx(async (t) => {
      const data: StockScreenDataDto = await getStockScreenData(t, screenId);
      if (!data.rows || !(await activeOptionsFeed(t))) return data;
      const today = nyDate(new Date());
      const signals = await latestSignalsBySymbol(t, addDays(today, -14));
      if (signals.size === 0) return data;
      const symbolAt = SCREEN_TEXT_COLUMNS.indexOf('symbol');
      return {
        ...data,
        rows: data.rows.map((row) => {
          const s = signals.get(String(row[symbolAt]));
          if (!s || tradingDaysBetween(s.date, today) > OPTION_SIGNAL_MAX_AGE_TRADING_DAYS)
            return row;
          return withScreenOptions(row, screenOptionColumns(s.values));
        }),
      };
    }),
  ),
);
