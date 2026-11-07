import type { ContractQuery, OptionBar, OptionContractRef } from '@tm/alpaca';
import {
  iv30Series,
  saveOptionSignal,
  updateSignalRank,
  updateUniverse,
  type Database,
  type UniverseRow,
} from '@tm/db';
import {
  addDays,
  computeChain,
  deriveSignals,
  isMonthlyExpiry,
  IV_RANK_WINDOW,
  IV_RANK_MIN_HISTORY,
  ivRankPercentile,
  nyDate,
  OPTIONS_HISTORY_DAYS_DEFAULT,
  tradingDays,
  weekday,
} from '@tm/domain';
import type { Logger } from 'pino';
import { dividendYieldOn, type MarketInputs } from './market-inputs';
import { realizedVol20 } from './recording';

/**
 * The history rebuild (options data brief v2 §5.2): once per underlying, when
 * it joins the universe, the worker rebuilds IV30, skew and term structure
 * for each past day from Alpaca's option bars (real trades, back to February
 * 2024) against the stock's close, with the same pricing package. A
 * contract's daily close stands in for its price, and only contracts that
 * traded at least 10 times that day are used. Rows are marked `rebuilt`:
 * they are approximate, because a thin strike's last trade can be hours old.
 * Open interest isn't in bars, so rebuilt days have no put/call ratios,
 * gamma exposure or open-interest levels.
 */

export interface RebuildSource {
  contracts(query: ContractQuery): Promise<OptionContractRef[]>;
  bars(symbols: readonly string[], from: string, to: string): Promise<Map<string, OptionBar[]>>;
}

export interface RebuildOptions {
  db: Database;
  inputs: MarketInputs;
  /** Alpaca option data through the app's own key; absent without one. */
  source: RebuildSource | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  historyDays?: number;
}

/** Alpaca's option history starts here. */
export const OPTION_BARS_START = '2024-02-01';
/** A contract counts on a day only when it traded at least this many times. */
export const MIN_TRADES = 10;
/** Contracts are kept within this distance of the price while they are within this many days of expiry. */
const STRIKE_BAND = 0.15;
const EXPIRY_LOOKBACK_DAYS = 75;

export const NO_REBUILD_KEY =
  'Waiting for the app’s Alpaca key (OPTIONS_ALPACA_KEY_ID and OPTIONS_ALPACA_SECRET_KEY on the worker). IV rank warms up over 120 days instead.';

export type RebuildOutcome = 'done' | 'waiting' | 'failed';

export async function rebuildUnderlying(
  o: RebuildOptions,
  u: Pick<UniverseRow, 'underlyingId' | 'symbol' | 'assetClass'>,
): Promise<RebuildOutcome> {
  const now = (o.now ?? (() => new Date()))();
  if (!o.source || !o.inputs.hasCloses) {
    await updateUniverse(o.db, u.underlyingId, {
      rebuildStatus: 'waiting',
      rebuildNote: NO_REBUILD_KEY,
    });
    return 'waiting';
  }
  await updateUniverse(o.db, u.underlyingId, { rebuildStatus: 'running', rebuildNote: null });
  try {
    const today = nyDate(now);
    const historyDays = o.historyDays ?? OPTIONS_HISTORY_DAYS_DEFAULT;
    const from = [addDays(today, -historyDays), OPTION_BARS_START].sort().at(-1) as string;
    const to = addDays(today, -1);
    const days = tradingDays(from, to);
    const underlying = { id: u.underlyingId, symbol: u.symbol, assetClass: u.assetClass };
    const raw = await o.inputs.dailyBars(underlying, from, to, 'none');
    const closeOn = new Map(raw.map((b) => [nyDate(b.start), b.close.toNumber()]));
    const adjusted = await o.inputs.dailyBars(
      underlying,
      addDays(from, -45),
      to,
      'split_and_dividend',
    );
    const adjustedCloses = adjusted.map((b) => ({
      date: nyDate(b.start),
      close: b.close.toNumber(),
    }));
    if (closeOn.size === 0) {
      await updateUniverse(o.db, u.underlyingId, {
        rebuildStatus: 'waiting',
        rebuildNote: `Alpaca returned no daily bars for ${u.symbol}; the rebuild will try again tomorrow.`,
      });
      return 'waiting';
    }
    const closes = [...closeOn.values()];
    const low = Math.min(...closes) * (1 - STRIKE_BAND);
    const high = Math.max(...closes) * (1 + STRIKE_BAND);
    const contracts = (
      await o.source.contracts({
        underlying: u.symbol,
        expirationGte: from,
        expirationLte: addDays(to, 400),
        strikeGte: Math.floor(low),
        strikeLte: Math.ceil(high),
      })
    ).filter((c) => weekday(c.expiry) === 5 || isMonthlyExpiry(c.expiry));
    if (contracts.length === 0) {
      await updateUniverse(o.db, u.underlyingId, {
        rebuildStatus: 'waiting',
        rebuildNote: `Alpaca returned no option contracts for ${u.symbol}, so there is no history to rebuild; IV rank warms up over 120 days instead.`,
      });
      return 'waiting';
    }

    // Bars per expiry, over the days that expiry was within reach and near the money.
    const byExpiry = new Map<string, OptionContractRef[]>();
    for (const c of contracts) byExpiry.set(c.expiry, [...(byExpiry.get(c.expiry) ?? []), c]);
    const barsOf = new Map<string, Map<string, OptionBar>>();
    for (const [expiry, list] of byExpiry) {
      const start = [from, addDays(expiry, -EXPIRY_LOOKBACK_DAYS)].sort().at(-1) as string;
      const end = [to, expiry].sort()[0] as string;
      if (start > end) continue;
      const window = days.filter((d) => d >= start && d <= end);
      const near = list.filter((c) =>
        window.some((d) => {
          const S = closeOn.get(d);
          return S !== undefined && Math.abs(c.strike / S - 1) <= STRIKE_BAND;
        }),
      );
      if (near.length === 0) continue;
      const bars = await o.source.bars(
        near.map((c) => c.symbol),
        start,
        end,
      );
      for (const [symbol, list] of bars) {
        const m = new Map<string, OptionBar>();
        for (const b of list) m.set(nyDate(b.t), b);
        barsOf.set(symbol, m);
      }
    }

    // IV30 history to rank against: what is stored, then each rebuilt day as it is made.
    const stored = await iv30Series(o.db, u.underlyingId, addDays(from, -366));
    const recorded = new Set(stored.filter((s) => s.source === 'recorded').map((s) => s.date));
    const ivByDate = new Map<string, number>();
    for (const s of stored) if (s.iv30 !== null) ivByDate.set(s.date, s.iv30);
    const prior = (day: string) =>
      [...ivByDate.entries()]
        .filter(([d]) => d < day && d >= addDays(day, -366))
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .slice(0, IV_RANK_WINDOW)
        .map(([, v]) => v);

    let rebuilt = 0;
    for (const day of days) {
      if (recorded.has(day)) continue; // a recorded day is never overwritten
      const S = closeOn.get(day);
      if (S === undefined) continue;
      const r = await o.inputs.riskFreeRate(day);
      if (r === undefined) continue;
      const q = await dividendYieldOn(o.db, u, day, S);
      const traded = contracts.flatMap((c) => {
        const bar = barsOf.get(c.symbol)?.get(day);
        return bar && bar.n >= MIN_TRADES && c.expiry > day ? [{ c, bar }] : [];
      });
      if (traded.length === 0) continue;
      const computed = computeChain(
        { asOfDate: day, S, r, q },
        traded.map(({ c, bar }) => ({
          expiry: c.expiry,
          strike: c.strike,
          right: c.right,
          price: bar.c,
        })),
      );
      const closesToDay = adjustedCloses.filter((b) => b.date <= day).map((b) => b.close);
      const result = deriveSignals({
        asOfDate: day,
        S,
        r,
        q,
        rows: traded.map(({ c }, i) => ({
          expiry: c.expiry,
          strike: c.strike,
          right: c.right,
          bid: null,
          ask: null,
          volume: null,
          openInterest: null,
          iv: computed[i]?.iv ?? null,
          delta: computed[i]?.delta ?? null,
          gamma: computed[i]?.gamma ?? null,
        })),
        realizedVol20: realizedVol20(closesToDay),
        priorIv30: prior(day),
      });
      if (result.values.iv30 === null) continue;
      ivByDate.set(day, result.values.iv30);
      await saveOptionSignal(o.db, {
        underlyingId: u.underlyingId,
        asOfDate: day,
        values: result.values,
        ivHistoryDays: result.ivHistoryDays,
        expiries: result.expiries,
        underlyingClose: S,
        riskFreeRate: r,
        dividendYield: q,
        source: 'rebuilt',
        feed: 'alpaca_bars',
        computedAt: now,
      });
      rebuilt++;
    }

    // Recorded days made before the rebuild now have a year behind them.
    for (const day of [...recorded].sort()) {
      const iv = ivByDate.get(day);
      if (iv === undefined) continue;
      await updateSignalRank(
        o.db,
        u.underlyingId,
        day,
        ivRankPercentile(iv, prior(day), IV_RANK_MIN_HISTORY),
      );
    }

    await updateUniverse(o.db, u.underlyingId, {
      rebuildStatus: 'done',
      rebuiltAt: now,
      rebuildNote: `${rebuilt} trading days rebuilt from Alpaca option bars (${from} to ${to}); approximate.`,
    });
    o.logger.info({ symbol: u.symbol, rebuilt, from, to }, 'options history rebuilt');
    return 'done';
  } catch (e) {
    const message = (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 200);
    o.logger.warn({ symbol: u.symbol, err: { message } }, 'options history rebuild failed');
    await updateUniverse(o.db, u.underlyingId, {
      rebuildStatus: 'failed',
      rebuildNote: `The rebuild failed: ${message}. It will try again tomorrow.`,
    });
    return 'failed';
  }
}
