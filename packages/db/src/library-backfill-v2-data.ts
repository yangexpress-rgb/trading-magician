import type {
  DataNeed,
  LibraryDirection,
  libraryUniverseSchema,
  parameterSchema,
  positionSizingSchema,
  rebalanceScheduleSchema,
  stopLossSchema,
} from '@tm/domain';
import type { z } from 'zod';

type LibraryParameter = z.input<typeof parameterSchema>;
type PositionSizing = z.input<typeof positionSizingSchema>;
type StopLoss = z.input<typeof stopLossSchema>;
type RebalanceScheduleValue = z.input<typeof rebalanceScheduleSchema>;
type LibraryUniverse = z.input<typeof libraryUniverseSchema>;

/**
 * The Library v2 field values for the 31 seed entries (ADR 0055, brief
 * "Strategy Library v2" §2.3), keyed by seed key so they survive renumbering.
 *
 * Every value comes from the entry's own seed prose (entry, exit, assets,
 * data requirements, long description) or, for S00001-SD, S00003-SD and
 * S00012-SQ, from the brief's worked examples, which win. Nothing comes from
 * how a Lab strategy happens to implement the rule. Where the prose does not
 * say, the value is `unspecified` (or null / empty), and the dry-run report
 * lists it. Maturity is not here: it is derived from the database at run time.
 */

export type BackfillField =
  | 'direction'
  | 'parameters'
  | 'positionSizing'
  | 'stopLoss'
  | 'rebalanceSchedule'
  | 'keyRisks'
  | 'dataNeeds'
  | 'universe';

export interface BackfillValues {
  direction: LibraryDirection | null;
  parameters: LibraryParameter[];
  positionSizing: PositionSizing;
  stopLoss: StopLoss;
  rebalanceSchedule: RebalanceScheduleValue;
  keyRisks: string;
  dataNeeds: DataNeed[];
  universe: LibraryUniverse;
}

export interface BackfillRow {
  values: BackfillValues;
  /** Where a value came from, when not the field's usual source (see DEFAULT_SOURCES). */
  sources?: Partial<Record<BackfillField, string>>;
  /** Judgement calls Yong should look at in the dry-run report. */
  notes?: string[];
}

export const DEFAULT_SOURCES: Record<BackfillField, string> = {
  direction: 'seed entry and exit rules',
  parameters: 'seed entry and exit rules',
  positionSizing: 'seed entry rule',
  stopLoss: 'seed exit rule',
  rebalanceSchedule: 'seed entry and exit rules',
  keyRisks: 'seed long description (risks)',
  dataNeeds: 'seed data requirements',
  universe: 'seed assets',
};

const WORKED: Partial<Record<BackfillField, string>> = Object.fromEntries(
  (
    [
      'direction',
      'parameters',
      'positionSizing',
      'stopLoss',
      'rebalanceSchedule',
      'keyRisks',
      'dataNeeds',
      'universe',
    ] as const
  ).map((f) => [f, "brief's worked example"]),
);

const p = (name: string, value: string, unit?: string): LibraryParameter =>
  unit ? { name, value, unit } : { name, value };
const sizing = (method: PositionSizing['method'], detail?: string): PositionSizing =>
  detail ? { method, detail } : { method };
const stop = (method: StopLoss['method'], detail?: string): StopLoss =>
  detail ? { method, detail } : { method };
const schedule = (
  s: RebalanceScheduleValue['schedule'],
  detail?: string,
): RebalanceScheduleValue => (detail ? { schedule: s, detail } : { schedule: s });
const universe = (kind: LibraryUniverse['kind'], detail?: string): LibraryUniverse =>
  detail ? { kind, detail } : { kind };

const NOT_SIZED = sizing('unspecified');
const NO_STOP_SAID = stop('unspecified');
const INTRADAY_NOTE =
  'Intraday rule: the schedule list has no intraday value, so it is "No schedule" with the timing in the detail.';

export const LIBRARY_V2_BACKFILL: Record<string, BackfillRow> = {
  'seed-01-trend-sma200': {
    values: {
      direction: 'long_only',
      parameters: [p('SMA lookback', '200', 'days')],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('daily_close'),
      keyRisks:
        'Whipsaw in sideways markets — the rule lags the turn and gives back gains; no stop is specified in the research.',
      dataNeeds: ['daily_bars'],
      universe: universe('single_instrument', 'SPY'),
    },
    sources: WORKED,
    notes: [
      'The worked example has stop loss Not specified, although the seed exit says "No separate stop" (which §2.2 would record as No stop).',
    ],
  },
  'seed-02-cross-sectional-momentum': {
    values: {
      direction: 'long_only',
      parameters: [
        p('Momentum lookback', '12', 'months'),
        p('Momentum skip', '1', 'month'),
        p('Top-decile cutoff', '10', '%'),
      ],
      positionSizing: sizing('equal_weight', 'Top-decile stocks held in equal weight'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('month_end', 'First trading day of each month'),
      keyRisks:
        "Momentum crashes after sharp market reversals, high turnover and its costs, and concentration in whatever sector has led recently. Using today's S&P 500 members for past dates adds survivorship bias to any back test.",
      dataNeeds: ['daily_bars'],
      universe: universe('index_members', 'S&P 500 (current members)'),
    },
  },
  'seed-03-mean-reversion-rsi2': {
    values: {
      direction: 'long_only',
      parameters: [
        p('RSI lookback', '2', 'bars'),
        p('RSI entry threshold', '10'),
        p('Exit SMA lookback', '5', 'days'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('daily_close'),
      keyRisks:
        'Mean reversion fails in strong trends — a falling market keeps making new RSI lows while the rule keeps buying; the exit depends on a bounce that may not come.',
      dataNeeds: ['daily_bars'],
      universe: universe('single_instrument', 'SPY'),
    },
    sources: WORKED,
    notes: [
      'The worked example leaves out the 200-day moving-average filter in the seed entry rule; it is not added as a parameter.',
    ],
  },
  'seed-04-pairs-pep-ko': {
    values: {
      direction: 'long_short',
      parameters: [
        p('Z-score lookback', '60', 'days'),
        p('Entry z-score', '-2'),
        p('Exit z-score', '0'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('daily_close', 'Signal on the close, trade at the next open'),
      keyRisks:
        'The relationship can break for good (a merger, a lost contract, a change of business), and a raw price spread drifts as prices change, unlike a hedge-ratio spread.',
      dataNeeds: ['daily_bars', 'short_borrow'],
      universe: universe('list', 'PEP and KO'),
    },
    notes: [
      'Direction is the full pair (long PEP, short KO), not the long-only half; Long and short rather than Market neutral because the raw price spread is not hedge-ratio neutral.',
    ],
  },
  'seed-05-breakout-donchian': {
    values: {
      direction: 'long_only',
      parameters: [p('Entry channel', '20', 'days'), p('Exit channel', '10', 'days')],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('daily_close', 'Signal on the close, trade at the next open'),
      keyRisks: 'False breakouts in range-bound markets, and gap moves through the exit level.',
      dataNeeds: ['daily_bars'],
      universe: universe('single_instrument', 'SPY'),
    },
  },
  'seed-06-volatility-vix-bollinger': {
    values: {
      direction: 'long_only',
      parameters: [p('Bollinger lookback', '20', 'bars'), p('Bollinger width', '2', 'SD')],
      positionSizing: NOT_SIZED,
      stopLoss: stop('none', 'No price stop in the rule as described'),
      rebalanceSchedule: schedule('daily_close', 'Signal on the close, trade at the next open'),
      keyRisks:
        'In a sustained crash the VIX can stay elevated while stocks keep falling; there is no price stop in the rule as described.',
      dataNeeds: ['daily_bars', 'index_data'],
      universe: universe('single_instrument', 'SPY (the VIX is a signal only)'),
    },
    sources: { stopLoss: 'seed long description ("no price stop")' },
  },
  'seed-07-value-dividend-yearly': {
    values: {
      direction: 'long_only',
      parameters: [p('Holdings', '10', 'stocks')],
      positionSizing: sizing('equal_weight', 'The 10 cheapest stocks held in equal weight'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('year_end', 'First trading day of the year'),
      keyRisks:
        "Value traps (cheap for a reason), long periods of underperformance, sector concentration (for example in financials or energy), and survivorship bias when back tested on today's members.",
      dataNeeds: ['daily_bars', 'fundamentals'],
      universe: universe('index_members', 'S&P 500'),
    },
  },
  'seed-08-sector-rotation': {
    values: {
      direction: 'long_only',
      parameters: [
        p('Momentum lookback', '6', 'months'),
        p('Trend filter SMA', '200', 'days'),
        p('Holdings', '3', 'ETFs'),
      ],
      positionSizing: sizing(
        'equal_weight',
        'Top 3 held in equal weight; cash for any slot the filter leaves empty',
      ),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('month_end', 'First trading day of each month'),
      keyRisks:
        'Sharp sector reversals, crowding into the same few leaders, and the cost of monthly turnover.',
      dataNeeds: ['daily_bars'],
      universe: universe('sector_etfs', 'XLB, XLE, XLF, XLI, XLK, XLP, XLU, XLV, XLY'),
    },
  },
  'seed-09-dual-momentum': {
    values: {
      direction: 'long_only',
      parameters: [p('Momentum lookback', '12', 'months')],
      positionSizing: sizing('other', 'Fully in the one asset the rule picks'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('month_end', 'Monthly review'),
      keyRisks:
        'Lag at turning points, a whipsaw year when markets chop, and dependence on a single lookback.',
      dataNeeds: ['daily_bars'],
      universe: universe('list', 'SPY, EFA and AGG'),
    },
  },
  'seed-10-covered-calls': {
    values: {
      direction: 'long_only',
      parameters: [p('Call tenor', '1', 'month'), p('Call strike', 'At the money')],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('month_end', 'Each monthly option expiration'),
      keyRisks:
        'The stock downside is kept in full while the upside is capped, so the strategy lags in strong rallies; results depend on option prices and execution costs.',
      dataNeeds: ['daily_bars', 'options_chains'],
      universe: universe('single_instrument', 'S&P 500 (index or SPY) plus monthly calls on it'),
    },
  },
  'seed-11-cash-secured-puts-wheel': {
    values: {
      direction: 'long_only',
      parameters: [p('Put tenor', '1', 'month'), p('Put strike', 'At or near the money')],
      positionSizing: sizing('other', 'Enough cash kept to buy the shares if assigned'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('month_end', 'Each monthly option expiration'),
      keyRisks:
        'Large losses in a falling market (the put seller owns the decline below the strike), capped upside, and assignment and execution costs.',
      dataNeeds: ['daily_bars', 'options_chains'],
      universe: universe(
        'single_instrument',
        'S&P 500 (index or SPY) or single stocks, plus monthly options',
      ),
    },
  },
  'seed-12-multi-factor': {
    values: {
      direction: 'long_only',
      parameters: [
        p('P/E ceiling', '20'),
        p('Earnings yield floor', '0'),
        p('Momentum lookback', '12', 'months'),
        p('Momentum skip', '1', 'month'),
        p('Top-decile cutoff', '10', '%'),
      ],
      positionSizing: sizing('equal_weight', 'Top-decile picks held in equal weight'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('quarter_end'),
      keyRisks:
        "Survivorship bias — the backtest uses today's S&P 500 members for the whole period; quality factor omitted (no quality metric in the app).",
      dataNeeds: ['daily_bars', 'fundamentals'],
      universe: universe('index_members', 'S&P 500 (current members; backtest-only)'),
    },
    sources: WORKED,
  },
  'seed-13-carry': {
    values: {
      direction: 'long_short',
      parameters: [p('Long group', 'Highest-carry third'), p('Short group', 'Lowest-carry third')],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('month_end', 'Monthly, within each asset class'),
      keyRisks:
        'Sudden unwinds in crises (carry trades crash together), leverage, and the cost of futures roll and financing.',
      dataNeeds: [],
      universe: universe(
        'multi_asset',
        'Currency forwards, commodity futures and government bond futures',
      ),
    },
    notes: ['Data needs: FX, futures roll and bond data have no data-need value, so it is empty.'],
  },
  'seed-14-merger-arbitrage': {
    values: {
      direction: 'long_short',
      parameters: [],
      positionSizing: NOT_SIZED,
      stopLoss: stop('condition_based', 'Close at once if the deal is withdrawn or blocked'),
      rebalanceSchedule: schedule('event_driven', 'Deal announcements and completions'),
      keyRisks:
        'A broken deal can lose many times the expected spread, and losses cluster in market downturns, when deals fail together.',
      dataNeeds: ['news', 'short_borrow'],
      universe: universe(
        'broad_us_stocks',
        'US stocks that are targets (and acquirers) in announced deals',
      ),
    },
    notes: ['Data needs: the corporate deal-events feed is recorded as News (no closer value).'],
  },
  'seed-15-convertible-arbitrage': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: sizing('other', "Stock short sized to the bond's delta"),
      stopLoss: stop('condition_based', 'Unwind when credit worsens'),
      rebalanceSchedule: schedule('daily_close', 'Stock hedge re-balanced daily'),
      keyRisks:
        'Credit losses, liquidity crises when many funds sell at once, short-borrow recalls and leverage.',
      dataNeeds: ['short_borrow'],
      universe: universe('multi_asset', "Convertible bonds and the issuers' common stock"),
    },
    notes: ['Data needs: convertible bond prices and terms have no data-need value.'],
  },
  'seed-16-volatility-dispersion': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: sizing('other', 'Member straddles weighted to match the index leg'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('daily_close', 'Deltas re-hedged daily'),
      keyRisks:
        'Correlation spikes in sell-offs (all stocks fall together), heavy transaction costs across many option positions, and the need for daily hedging.',
      dataNeeds: ['options_chains'],
      universe: universe(
        'index_members',
        'S&P 500 index options and options on its larger members',
      ),
    },
  },
  'seed-17-market-making': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: sizing('other', 'Quotes sized and skewed by current inventory'),
      stopLoss: stop(
        'condition_based',
        'Flatten at the end of the day or when inventory limits are hit',
      ),
      rebalanceSchedule: schedule('none', 'Continuous quoting'),
      keyRisks:
        'Adverse selection (trading against better-informed orders), inventory losses in fast moves, and a technology race on speed.',
      dataNeeds: ['level2_tick'],
      universe: universe('multi_asset', 'Liquid stocks, ETFs and futures'),
    },
  },
  'seed-18-global-macro': {
    values: {
      direction: null,
      parameters: [],
      positionSizing: sizing('risk_based', 'Sized to a risk budget'),
      stopLoss: stop('other', 'A stop set by the risk budget'),
      rebalanceSchedule: schedule('event_driven', 'When a macro thesis forms or is invalidated'),
      keyRisks:
        'Being wrong on a large, leveraged view; event risk around policy decisions; results that depend heavily on the manager.',
      dataNeeds: [],
      universe: universe(
        'multi_asset',
        'Currencies, government bonds and rates, equity index futures and commodities',
      ),
    },
    notes: [
      'Direction left Not specified: the prose does not say.',
      'Data needs: macroeconomic data has no data-need value.',
    ],
  },
  'seed-19-intraday-momentum': {
    values: {
      direction: 'long_short',
      parameters: [
        p('Signal window', 'Previous close to 10:00 ET'),
        p('Entry time', '15:30 ET'),
        p('Exit time', '16:00 ET'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('none', 'Intraday: enter 15:30 ET, flat at the close'),
      keyRisks:
        'Treat as decayed: independent replications found it loses net of a 2bp cost on SPY, QQQ, IWM and DIA, and much of the "intraday" effect was the overnight gap, not the session.',
      dataNeeds: ['intraday_bars'],
      universe: universe('single_instrument', 'SPY (also QQQ, IWM, DIA in the paper)'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: [INTRADAY_NOTE],
  },
  'seed-20-opening-range-breakout': {
    values: {
      direction: 'long_short',
      parameters: [p('Opening range', '5', 'minutes'), p('Entry time', '09:35 ET')],
      positionSizing: NOT_SIZED,
      stopLoss: stop(
        'condition_based',
        'Opposite extreme of the opening range (or a fraction of ATR)',
      ),
      rebalanceSchedule: schedule('none', 'Intraday: enter from 09:35 ET, flat at the close'),
      keyRisks:
        'The relative-volume filter did the work, not the breakout: plain 5-minute ORB returned 3.2% a year; the edge sits in a few large winners, with a low win rate and long losing streaks.',
      dataNeeds: ['intraday_bars'],
      universe: universe('broad_us_stocks', 'US stocks (universe scan) or QQQ/TQQQ'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: [INTRADAY_NOTE],
  },
  'seed-21-gap-and-go': {
    values: {
      direction: 'long_short',
      parameters: [
        p('Minimum gap', '0.5', '%'),
        p('Confirmation candle', '5', 'minutes'),
        p('Profit target', '2', 'R'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: stop(
        'condition_based',
        "The confirmation candle's low/high; exit if price fills the gap within the first hour",
      ),
      rebalanceSchedule: schedule(
        'none',
        'Intraday: after the open on gap days, flat by the close',
      ),
      keyRisks:
        'No peer-reviewed study and no audited win rate; gaps without a catalyst underperform, and gap-fill reversals within the first hour are the main failure.',
      dataNeeds: ['daily_bars', 'intraday_bars', 'news'],
      universe: universe(
        'multi_asset',
        'E-mini futures (MES, MNQ, YM, RTY) or single stocks after earnings gaps',
      ),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: [INTRADAY_NOTE],
  },
  'seed-22-vwap-mean-reversion': {
    values: {
      direction: 'long_short',
      parameters: [
        p('Bar size', '5', 'minutes'),
        p('Entry band', '2–3', 'SD from VWAP'),
        p('Stop band', '3', 'SD from VWAP'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: stop('condition_based', 'Just beyond 3 standard deviations from VWAP'),
      rebalanceSchedule: schedule('none', 'Intraday on 5-minute bars, flat by the close'),
      keyRisks:
        'Regime failure: on trend days price rides away from VWAP and fading loses repeatedly; costs dominate because targets are small. No peer-reviewed evidence that it is profitable.',
      dataNeeds: ['intraday_bars'],
      universe: universe('single_instrument', 'SPY (or any liquid stock/ETF with volume)'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: [INTRADAY_NOTE],
  },
  'seed-23-scalping': {
    values: {
      direction: null,
      parameters: [p('Bar size', '1', 'minute'), p('Time stop', '5–30', 'minutes')],
      positionSizing: NOT_SIZED,
      stopLoss: stop(
        'condition_based',
        'A few ticks beyond the flag; time-stop after 5–30 minutes',
      ),
      rebalanceSchedule: schedule('none', 'Intraday: many trades a day, seconds to minutes each'),
      keyRisks:
        'Costs dominate because targets are a few ticks; under 1% of day traders are reliably profitable net of fees, and 97% of persistent futures day traders in one study lost money.',
      dataNeeds: ['intraday_bars'],
      universe: universe('multi_asset', 'Liquid stocks / E-mini futures (ES, NQ)'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: [
      INTRADAY_NOTE,
      'Direction left Not specified: scalping is a style, and the example signal is long only.',
    ],
  },
  'seed-24-intraday-pairs': {
    values: {
      direction: 'market_neutral',
      parameters: [
        p('Z-score lookback', '30', 'minutes'),
        p('Entry z-score', '±1.5'),
        p('Exit z-score', '0.5'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: stop('time_stop', 'Exit on a time-stop if the spread has not reverted'),
      rebalanceSchedule: schedule('none', 'Intraday: reversion in 10–30 minutes'),
      keyRisks:
        'Decay: with costs the rule has been largely unprofitable since 2002; convergence still happens, but divergences no longer exceed the round-trip cost.',
      dataNeeds: ['intraday_bars', 'short_borrow'],
      universe: universe('list', 'SPY vs QQQ (or two correlated stocks)'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: [INTRADAY_NOTE],
  },
  'seed-25-news-reaction': {
    values: {
      direction: 'long_short',
      parameters: [p('Slow-variant wait', '15–30', 'minutes')],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('event_driven', 'Scheduled CPI, NFP and FOMC releases'),
      keyRisks:
        'Algorithms reprice in milliseconds and market makers withdraw liquidity before the print: a trader reacting to a headline on a screen trades after the repricing. The edge is infrastructure.',
      dataNeeds: ['intraday_bars', 'news', 'level2_tick'],
      universe: universe(
        'multi_asset',
        'US equities / index futures around CPI, NFP, FOMC releases',
      ),
    },
    sources: { keyRisks: 'seed long description, condensed' },
  },
  'seed-26-pead': {
    values: {
      direction: 'long_short',
      parameters: [
        p('Long group', 'Top SUE decile'),
        p('Short group', 'Bottom SUE decile'),
        p('Holding period', '60', 'trading days'),
      ],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule(
        'event_driven',
        'Earnings announcements; hold about 60 trading days',
      ),
      keyRisks:
        'Decay: the drift is much smaller in recent decades and weak or absent among large liquid US stocks; consensus estimates, which SUE needs, are paid data.',
      dataNeeds: ['daily_bars', 'earnings_consensus'],
      universe: universe('broad_us_stocks', 'US stocks around earnings announcements'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
  },
  'seed-27-latency-arbitrage': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('none', 'Continuous; positions last milliseconds'),
      keyRisks:
        'If you are not first you are the counterparty being arbitraged; the prize goes to the fastest few, and no retail-accessible version exists.',
      dataNeeds: ['level2_tick'],
      universe: universe(
        'multi_asset',
        'ES futures vs SPY; same stock across venues; futures vs ETF vs constituents vs options',
      ),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
  },
  'seed-28-order-book-imbalance': {
    values: {
      direction: 'long_short',
      parameters: [],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('none', 'Continuous; positions last seconds'),
      keyRisks:
        'A statistical relationship in price changes is not a tradeable edge after spread, fees and slippage; the signal decays in seconds, and resting size can be cancelled instantly or posted to mislead.',
      dataNeeds: ['level2_tick'],
      universe: universe('broad_us_stocks', 'Liquid US stocks (top of book)'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
  },
  'seed-29-rebate-trading': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('none', 'Continuous quoting'),
      keyRisks:
        'Adverse selection: a trader posting passive orders earns the rebate but pays it back many times over by being filled when the price moves away; it only works at HFT scale and speed.',
      dataNeeds: ['level2_tick'],
      universe: universe('broad_us_stocks', 'Liquid US stocks on rebate-paying venues'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
  },
  'seed-30-index-etf-arbitrage': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: NOT_SIZED,
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule(
        'none',
        'Continuous; close at expiry or when the basis normalises',
      ),
      keyRisks:
        'The edge is competed away for anyone without Authorized Participant status and speed; in stressed markets APs step back and premiums and discounts gap.',
      dataNeeds: ['level2_tick', 'index_data', 'short_borrow'],
      universe: universe(
        'multi_asset',
        'Index futures vs the underlying basket; ETF vs iNAV/basket',
      ),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
    notes: ['Data needs: iNAV and basket composition are recorded as Index data.'],
  },
  'seed-31-triangular-arbitrage': {
    values: {
      direction: 'market_neutral',
      parameters: [],
      positionSizing: sizing('other', 'All three legs in the right notionals'),
      stopLoss: NO_STOP_SAID,
      rebalanceSchedule: schedule('none', 'Continuous; a single atomic round trip'),
      keyRisks:
        'Leg risk: one leg fails to fill or reprices between legs and the "risk-free" trade becomes a directional bet; retail FX spreads alone exceed typical mispricings.',
      dataNeeds: ['level2_tick'],
      universe: universe('list', 'EUR/USD, USD/JPY, EUR/JPY (or any FX triplet) on one venue'),
    },
    sources: { keyRisks: 'seed long description (evidence), condensed' },
  },
};
