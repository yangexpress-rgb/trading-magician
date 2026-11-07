import {
  claimLiveChains,
  eq,
  finishLiveChain,
  iv30Series,
  pruneLiveChains,
  schema,
  underlyingsBySymbol,
  type Database,
} from '@tm/db';
import {
  addDays,
  atmStrike,
  buildLiveChainView,
  CboeOptionsFormatError,
  computeChain,
  DAYS_PER_YEAR,
  daysBetween,
  deriveSignals,
  forwardPrice,
  IV_RANK_WINDOW,
  midQuote,
  nyDate,
  usableQuote,
  type Bar,
  type LiveChainView,
} from '@tm/domain';
import type { Logger } from 'pino';
import type { ChainSource } from './cboe-options';
import { dividendYieldOn, type MarketInputs } from './market-inputs';
import { realizedVol20 } from './recording';

/**
 * The on-demand live chain behind Research › Options (options data brief v2
 * §10 item 8, ADR 0048). The app asks for a symbol; this loop fetches its
 * delayed chain, prices it with the app's own model against the chain's
 * underlying price, derives the figures and stores the view for 15 minutes.
 * Any US stock or ETF can be asked for, recorded or not.
 */

export interface LiveChainOptions {
  db: Database;
  chains: ChainSource;
  inputs: MarketInputs;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  pollMs?: number;
}

const MAX_ATTEMPTS = 2;

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'The chain could not be read')
    .replace(/\s+/g, ' ')
    .slice(0, 200);

/** Fetches and prices one symbol's chain into the stored view. */
export async function buildLiveChain(
  o: LiveChainOptions,
  symbol: string,
): Promise<LiveChainView | { error: string }> {
  const fetched = await o.chains.chain(symbol);
  const chain = fetched.chain;
  const asOfDate = nyDate(chain.fileTimestamp);
  const known = await underlyingsBySymbol(o.db, [symbol]);
  const underlyingId = known.get(symbol);
  const underlying = underlyingId
    ? { id: underlyingId, symbol, assetClass: await assetClassOf(o, underlyingId) }
    : undefined;

  let S = chain.underlyingPrice;
  let priceSource: 'chain' | 'close' = 'chain';
  let closes: Bar[] = [];
  if (underlying) {
    closes = await o.inputs.dailyBars(
      underlying,
      addDays(asOfDate, -45),
      asOfDate,
      'split_and_dividend',
    );
  }
  if (!(S && S > 0)) {
    const last = closes.at(-1)?.close.toNumber();
    if (!(last && last > 0))
      return { error: `CBOE's ${symbol} file has no underlying price and no close is stored` };
    S = last;
    priceSource = 'close';
  }
  const r = await o.inputs.riskFreeRate(asOfDate);
  if (r === undefined) return { error: 'The risk-free rate could not be read from FRED' };
  const q = underlying ? await dividendYieldOn(o.db, underlying, asOfDate, S) : 0;

  const computed = computeChain(
    { asOfDate, S, r, q },
    chain.rows.map((x) => ({
      expiry: x.expiry,
      strike: x.strike,
      right: x.right,
      price: usableQuote(x.bid, x.ask) ? midQuote(x.bid, x.ask) : undefined,
    })),
  );
  const rows = chain.rows.map((x, i) => ({
    expiry: x.expiry,
    strike: x.strike,
    right: x.right,
    bid: x.bid,
    ask: x.ask,
    volume: x.volume,
    openInterest: x.openInterest,
    iv: computed[i]?.iv ?? null,
    delta: computed[i]?.delta ?? null,
    gamma: computed[i]?.gamma ?? null,
  }));
  // IV rank and percentile against the recorded days before this one, when recorded.
  const prior = underlyingId
    ? (await iv30Series(o.db, underlyingId, addDays(asOfDate, -366)))
        .filter((p) => p.date < asOfDate && p.iv30 != null)
        .slice(-IV_RANK_WINDOW)
        .map((p) => p.iv30 as number)
    : [];
  const result = deriveSignals({
    asOfDate,
    S,
    r,
    q,
    rows,
    realizedVol20: realizedVol20(
      closes.filter((b) => nyDate(b.start) <= asOfDate).map((b) => b.close.toNumber()),
    ),
    priorIv30: prior,
  });
  const atmStrikes = new Map<string, number | undefined>();
  for (const e of result.expiries) {
    const strikes = [...new Set(rows.filter((x) => x.expiry === e.expiry).map((x) => x.strike))];
    const F = forwardPrice(S, daysBetween(asOfDate, e.expiry) / DAYS_PER_YEAR, r, q);
    atmStrikes.set(e.expiry, atmStrike(strikes, F));
  }
  return buildLiveChainView({
    symbol,
    chainTime: chain.fileTimestamp,
    asOfDate,
    S,
    priceSource,
    r,
    q,
    // The source's quotes stop here: the view takes computed values, OI and volume only.
    rows: rows.map((x) => ({ ...x, bid: null, ask: null })),
    values: result.values,
    ivHistoryDays: result.ivHistoryDays,
    expiries: result.expiries,
    atmStrikes,
    skipped: chain.skipped,
  });
}

async function assetClassOf(o: LiveChainOptions, id: string) {
  const [row] = await o.db
    .select({ assetClass: schema.instruments.assetClass })
    .from(schema.instruments)
    .where(eq(schema.instruments.id, id));
  return row?.assetClass ?? 'stock';
}

/** Answers the waiting requests once; returns how many were answered. */
export async function answerLiveChains(o: LiveChainOptions): Promise<number> {
  const claimed = await claimLiveChains(o.db, { leaseSeconds: 120, limit: 3 });
  for (const c of claimed) {
    try {
      const view = await buildLiveChain(o, c.symbol);
      if ('error' in view)
        await finishLiveChain(o.db, c.symbol, { status: 'failed', message: view.error });
      else await finishLiveChain(o.db, c.symbol, { status: 'ready', view });
    } catch (e) {
      const permanent = e instanceof CboeOptionsFormatError || c.attempts >= MAX_ATTEMPTS;
      o.logger.warn({ symbol: c.symbol, err: { message: shortError(e) } }, 'live chain failed');
      await finishLiveChain(
        o.db,
        c.symbol,
        permanent
          ? {
              status: 'failed',
              message:
                e instanceof CboeOptionsFormatError
                  ? e.message
                  : `CBOE could not be read: ${shortError(e)}`,
            }
          : { status: 'retry' },
      );
    }
  }
  return claimed.length;
}

export interface LiveChainLoop {
  stop: () => Promise<void>;
}

export function startLiveChainLoop(o: LiveChainOptions): LiveChainLoop {
  const pollMs = o.pollMs ?? 2000;
  let running = true;
  let wake: (() => void) | undefined;
  let prunedAt = 0;
  const done = (async () => {
    while (running) {
      try {
        await answerLiveChains(o);
        if (Date.now() - prunedAt > 3600_000) {
          await pruneLiveChains(o.db);
          prunedAt = Date.now();
        }
      } catch (error) {
        const e = error as { name?: string; message?: string };
        o.logger.warn({ err: { name: e.name, message: e.message } }, 'live chain loop failed');
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();
  return {
    stop: async () => {
      running = false;
      wake?.();
      await done;
    },
  };
}
