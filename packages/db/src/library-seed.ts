import { sql } from 'drizzle-orm';
import { parseRegistrationNumber, v3NumberFor, type RegisterLibraryEntryInput } from '@tm/domain';
import type { Database, Transaction } from './client';
import { registerLibraryEntry } from './library';
import { LIBRARY_V2_BACKFILL } from './library-backfill-v2-data';
import { applyRenumberV2 } from './library-renumber';
import { STRATEGY_LIBRARY_SEED_SHORT_TERM } from './library-seed-short-term';
import { strategyLibraryEntries, strategyLibrarySequence } from './schema';

/**
 * The seed definition of the Strategy Library (ADR 0051): the 18 researched
 * strategies, registered in catalogue order. The numbers they must receive
 * are part of the definition and are checked on seeding; this is the one
 * place they are written down in code.
 *
 * Prose describes each rule as a person would explain it. Prior users are
 * named only with a published source, and no performance figures appear:
 * back test summaries are left for the linked Strategy Lab runs.
 */
export interface SeedEntry {
  seedKey: string;
  /** The number convention v1 issues it (letters-first); kept as its former number after v2. */
  v1Number: string;
  /** Its number under convention v2 (sequence-first, ADR 0055). */
  expectedNumber: string;
  /** Related entries, by their v2 numbers (set after all are registered). */
  related: string[];
  /**
   * Case-insensitive patterns matched against a workspace's strategy names by
   * `library:link-seed`, to link the built ones. Empty for unbuilt entries.
   */
  linkHints: string[];
  input: Omit<RegisterLibraryEntryInput, 'relatedEntries' | 'builtStrategyId'>;
}

const unknown = { kind: 'unknown' } as const;
const every = (value: number, unit: 'seconds' | 'months' | 'quarters' | 'years') =>
  ({ kind: 'every', value, unit }) as const;
const perYear = (value: number, low: number, high: number) =>
  ({ kind: 'per', value, unit: 'years', low, high }) as const;

const SEED_RESEARCHED: readonly SeedEntry[] = [
  {
    seedKey: 'seed-01-trend-sma200',
    v1Number: 'SDS-0001',
    expectedNumber: 'S00001-SD',
    related: ['S00009-SM', 'S00005-SD'],
    linkHints: ['sma ?200', '^trend'],
    input: {
      name: 'Trend following — SPY SMA200',
      category: 'trend',
      tags: ['long-only', 'low-turnover', 'time-series momentum'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      shortDescription:
        'Long-only trend following on SPY: hold SPY while its price is above its 200-day moving average; otherwise hold cash.',
      longDescription:
        'The idea is that sustained price trends persist long enough to capture. The mechanism is a single slow filter — the 200-day simple moving average — applied to one liquid instrument, which keeps turnover low and the rule auditable.\n\nIts known weakness is whipsaw in sideways markets, where repeated crossings generate small losses and no trend payoff. It also gives back part of a move before the average turns, so it lags at both ends of a trend.',
      assets: 'SPY only',
      entry: 'Enter at the next open after SPY closes above its 200-day moving average.',
      exit: 'Exit at the next open after SPY closes below its 200-day moving average. No separate stop; the moving-average exit is the risk control.',
      frequency: perYear(2, 1, 6),
      turnaround: unknown,
      dataRequirements: `Daily bars with at least 200 days of history for SPY.`,
      usedBy: [
        {
          who: 'Mebane Faber',
          what: 'Published a moving-average timing rule (10-month average) for US stocks and other asset classes',
          evidence: 'paper',
          source:
            'Faber, M. T. (2007). A Quantitative Approach to Tactical Asset Allocation. Journal of Wealth Management.',
        },
      ],
      sources: [
        {
          title: 'A Quantitative Approach to Tactical Asset Allocation',
          citation: 'Faber, M. T. (2007). Journal of Wealth Management.',
        },
        {
          title: 'Time Series Momentum',
          citation:
            'Moskowitz, T. J., Ooi, Y. H. and Pedersen, L. H. (2012). Journal of Financial Economics 104(2).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-02-cross-sectional-momentum',
    v1Number: 'SMS-0002',
    expectedNumber: 'S00002-SM',
    related: ['S00009-SM', 'S00008-EM', 'S00012-SQ'],
    linkHints: [
      'cross.?sectional',
      'top decile',
      '^(?!.*(dual|value|factor)).*momentum.*(s&p|sp ?500)',
    ],
    input: {
      name: 'Cross-sectional momentum — S&P 500 top decile',
      category: 'momentum',
      tags: ['long-only', 'universe ranking', 'monthly rebalance'],
      timeframeCode: 'M',
      assetClassCode: 'S',
      shortDescription:
        'Each month, rank the S&P 500 by 12-month return skipping the latest month, and hold the top tenth equally weighted.',
      longDescription:
        "Stocks that have outperformed their peers over the past year have tended to keep outperforming for a few more months. The strategy ranks every member of the S&P 500 by its return over the last twelve months, leaving out the most recent month (which tends to reverse), and holds the top decile.\n\nRisks: momentum crashes after sharp market reversals, high turnover and its costs, and concentration in whatever sector has led recently. Using today's S&P 500 members for past dates adds survivorship bias to any back test.",
      assets: 'S&P 500 stocks (top decile held)',
      entry:
        'On the first trading day of each month, buy the stocks in the top 10% of the S&P 500 by total return from 12 months ago to 1 month ago, equal-weighted.',
      exit: 'At each monthly rebalance, sell any holding that is no longer in the top 10%.',
      frequency: every(1, 'months'),
      turnaround: unknown,
      dataRequirements: `Daily bars for every S&P 500 member with at least 13 months of history; the S&P 500 member list.`,
      usedBy: [
        {
          who: 'Narasimhan Jegadeesh and Sheridan Titman',
          what: 'Published the cross-sectional momentum effect in US stocks',
          evidence: 'paper',
          source:
            'Jegadeesh, N. and Titman, S. (1993). Returns to Buying Winners and Selling Losers. Journal of Finance 48(1).',
        },
      ],
      sources: [
        {
          title:
            'Returns to Buying Winners and Selling Losers: Implications for Stock Market Efficiency',
          citation: 'Jegadeesh, N. and Titman, S. (1993). Journal of Finance 48(1).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-03-mean-reversion-rsi2',
    v1Number: 'SDS-0003',
    expectedNumber: 'S00003-SD',
    related: ['S00001-SD', 'S00006-SD'],
    linkHints: ['rsi.?2', 'mean reversion'],
    input: {
      name: 'Mean reversion — SPY RSI-2',
      category: 'mean_reversion',
      tags: ['long-only', 'short-term'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      shortDescription:
        'Buy SPY after a sharp short-term pullback inside a long-term uptrend, measured by a 2-day RSI, and sell on the first bounce.',
      longDescription:
        'Short pullbacks in an index that is otherwise trending up have tended to revert within days. A 2-period RSI is a very fast oscillator: readings under 10 mark an unusually steep short-term drop. The 200-day average filter keeps the strategy out of falling markets, where pullbacks tend to continue.\n\nRisks: a pullback that turns into a crash with no stop below; many small wins can be erased by one large loss; results are sensitive to costs because trades are frequent and short.',
      assets: 'SPY only',
      entry:
        "Buy at the close when SPY's 2-day RSI is below 10 and SPY closes above its 200-day moving average.",
      exit: 'Sell at the close when SPY closes above its 5-day moving average.',
      frequency: perYear(6, 2, 12),
      turnaround: unknown,
      dataRequirements: `Daily bars with at least 200 days of history for SPY.`,
      usedBy: [
        {
          who: 'Larry Connors and Cesar Alvarez',
          what: 'Published the 2-period RSI pullback rule for index ETFs',
          evidence: 'book',
          source:
            'Connors, L. and Alvarez, C. (2008). Short Term Trading Strategies That Work. TradingMarkets Publishing.',
        },
      ],
      sources: [
        {
          title: 'Short Term Trading Strategies That Work',
          citation: 'Connors, L. and Alvarez, C. (2008). TradingMarkets Publishing.',
        },
      ],
    },
  },
  {
    seedKey: 'seed-04-pairs-pep-ko',
    v1Number: 'SDS-0004',
    expectedNumber: 'S00004-SD',
    related: ['S00015-AD', 'S00016-OD'],
    linkHints: ['pep', 'pairs'],
    input: {
      name: 'Pairs trading — PEP vs KO',
      category: 'pairs_stat_arb',
      tags: ['relative value', 'z-score'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      shortDescription:
        'Trade the price spread between PepsiCo and Coca-Cola when it stretches more than two standard deviations from its recent average.',
      longDescription:
        'Two companies in the same business tend to move together, so the gap between their prices tends to return to its usual level. The strategy measures the spread close(PEP) − close(KO), turns it into a z-score against its own 60-day mean and standard deviation, and bets on the spread closing.\n\nThe long-only half buys PEP when the spread is unusually low; the full rule also shorts KO. Risks: the relationship can break for good (a merger, a lost contract, a change of business), and a raw price spread drifts as prices change, unlike a hedge-ratio spread.',
      assets: 'PEP and KO',
      entry:
        'Buy PEP at the next open when the 60-day z-score of close(PEP) − close(KO) falls below −2 (the full pair also sells KO short).',
      exit: 'Close the position at the next open when the z-score rises back above 0.',
      frequency: perYear(4, 1, 8),
      turnaround: unknown,
      dataRequirements: `Daily bars for PEP and KO with at least 60 days of history; short selling for the full pair.`,
      usedBy: [
        {
          who: 'Evan Gatev, William Goetzmann and K. Geert Rouwenhorst',
          what: 'Published a study of a distance-based pairs trading rule on US stocks',
          evidence: 'paper',
          source:
            'Gatev, E., Goetzmann, W. N. and Rouwenhorst, K. G. (2006). Pairs Trading: Performance of a Relative-Value Arbitrage Rule. Review of Financial Studies 19(3).',
        },
      ],
      sources: [
        {
          title: 'Pairs Trading: Performance of a Relative-Value Arbitrage Rule',
          citation:
            'Gatev, E., Goetzmann, W. N. and Rouwenhorst, K. G. (2006). Review of Financial Studies 19(3).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-05-breakout-donchian',
    v1Number: 'SDS-0005',
    expectedNumber: 'S00005-SD',
    related: ['S00001-SD'],
    linkHints: ['donchian', 'turtle', 'breakout'],
    input: {
      name: 'Breakout — SPY Donchian 20/10',
      category: 'breakout',
      tags: ['long-only', 'channel breakout'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      shortDescription:
        'Buy SPY when it closes above its highest high of the last 20 days; sell when it closes below its lowest low of the last 10 days.',
      longDescription:
        'A breakout above a recent range is read as the start of a trend. The Donchian channel is simply the highest high and lowest low over a lookback; the faster 10-day exit channel locks in part of a move sooner than the entry channel would.\n\nThis is the short-term variant of the channel systems taught to the "Turtle" traders. Risks: false breakouts in range-bound markets, and gap moves through the exit level.',
      assets: 'SPY only',
      entry:
        'Buy at the next open after SPY closes above the highest high of the previous 20 trading days.',
      exit: 'Sell at the next open after SPY closes below the lowest low of the previous 10 trading days.',
      frequency: perYear(4, 2, 8),
      turnaround: unknown,
      dataRequirements: `Daily bars with at least 20 days of history for SPY.`,
      usedBy: [
        {
          who: 'The "Turtle" traders trained by Richard Dennis and William Eckhardt',
          what: 'Traded Donchian channel breakout systems (20-day entry and 10-day exit in System 1) across futures markets',
          evidence: 'book',
          source: 'Faith, C. (2007). Way of the Turtle. McGraw-Hill.',
        },
      ],
      sources: [{ title: 'Way of the Turtle', citation: 'Faith, C. (2007). McGraw-Hill.' }],
    },
  },
  {
    seedKey: 'seed-06-volatility-vix-bollinger',
    v1Number: 'SDS-0006',
    expectedNumber: 'S00006-SD',
    related: ['S00003-SD', 'S00016-OD'],
    linkHints: ['vix', 'bollinger'],
    input: {
      name: 'Volatility — VIX Bollinger signal, trades SPY',
      category: 'volatility',
      tags: ['long-only', 'contrarian', 'index signal'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      shortDescription:
        'Buy SPY when the VIX spikes above the upper Bollinger Band of its own recent range; exit when the VIX falls back to its average.',
      longDescription:
        "Fear spikes have tended to mark short-term lows in stocks. The VIX, the Cboe Volatility Index, is watched only as a signal and is never traded: the strategy buys SPY when the VIX closes above the upper Bollinger Band (20 bars, 2 standard deviations) of its own history, and leaves when the VIX calms back to the band's middle.\n\nRisks: in a sustained crash the VIX can stay elevated while stocks keep falling; there is no price stop in the rule as described.",
      assets: 'SPY (the VIX is a signal only)',
      entry:
        'Buy SPY at the next open after the VIX closes above BB_UPPER(VIX close, 20 bars, 2.0).',
      exit: 'Sell SPY at the next open after the VIX closes below BB_MIDDLE(VIX close, 20 bars, 2.0).',
      frequency: perYear(3, 1, 6),
      turnaround: unknown,
      dataRequirements: `Daily bars for SPY and daily VIX history (Cboe's free daily file) with at least 20 days of history.`,
      usedBy: [],
      sources: [
        {
          title: 'Bollinger on Bollinger Bands',
          citation: 'Bollinger, J. (2001). McGraw-Hill.',
        },
        {
          title: 'The Investor Fear Gauge',
          citation: 'Whaley, R. E. (2000). Journal of Portfolio Management 26(3).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-07-value-dividend-yearly',
    v1Number: 'SYS-0007',
    expectedNumber: 'S00007-SY',
    related: ['S00012-SQ'],
    linkHints: ['dividend', '^(?!.*(momentum|factor)).*value'],
    input: {
      name: 'Systematic value / dividend — S&P 500, yearly',
      category: 'value',
      tags: ['long-only', 'fundamentals', 'yearly rebalance'],
      timeframeCode: 'Y',
      assetClassCode: 'S',
      shortDescription:
        'Once a year, buy the cheapest S&P 500 stocks by a value measure such as earnings yield or dividend yield, equal-weighted, and hold for the year.',
      longDescription:
        "Stocks that are cheap relative to their earnings, book value or dividends have historically earned a premium over expensive stocks, though with long dry spells. The strategy ranks the S&P 500 once a year by a value measure from company filings (earnings yield or dividend yield) and holds the cheapest names until the next rebalance.\n\nRisks: value traps (cheap for a reason), long periods of underperformance, sector concentration (for example in financials or energy), and survivorship bias when back tested on today's members. The linked Strategy Lab definition sets the exact measure and number of holdings.",
      assets: 'S&P 500 stocks',
      entry:
        'On the first trading day of the year, buy the 10 S&P 500 stocks with the highest value score (earnings yield or dividend yield from filings), equal-weighted.',
      exit: 'At the next yearly rebalance, sell holdings that are no longer among the 10 cheapest.',
      frequency: every(1, 'years'),
      turnaround: every(1, 'years'),
      dataRequirements:
        'Point-in-time fundamentals from SEC filings (EDGAR company data feed) and daily bars for every S&P 500 member.',
      usedBy: [
        {
          who: "Michael O'Higgins",
          what: 'Published a yearly high-dividend-yield rotation among Dow stocks ("Dogs of the Dow")',
          evidence: 'book',
          source: "O'Higgins, M. and Downes, J. (1991). Beating the Dow. HarperCollins.",
        },
      ],
      sources: [
        {
          title: 'The Cross-Section of Expected Stock Returns',
          citation: 'Fama, E. F. and French, K. R. (1992). Journal of Finance 47(2).',
        },
        {
          title: 'Beating the Dow',
          citation: "O'Higgins, M. and Downes, J. (1991). HarperCollins.",
        },
      ],
    },
  },
  {
    seedKey: 'seed-08-sector-rotation',
    v1Number: 'SME-0008',
    expectedNumber: 'S00008-EM',
    related: ['S00002-SM', 'S00009-SM'],
    linkHints: ['sector'],
    input: {
      name: 'Sector rotation — 9 sector ETFs',
      category: 'momentum',
      tags: ['long-only', 'universe ranking', 'monthly rebalance', 'trend filter'],
      timeframeCode: 'M',
      assetClassCode: 'E',
      shortDescription:
        'Each month, hold the 3 of the 9 Select Sector ETFs with the strongest 6-month return, among those trading above their 200-day average.',
      longDescription:
        'Industry momentum: sectors that have led recently have tended to keep leading for a while. The strategy ranks the nine original Select Sector SPDR ETFs by six-month total return, keeps only those above their 200-day moving average, and holds the top three equally weighted. When fewer than three pass the filter, the rest stays in cash.\n\nRisks: sharp sector reversals, crowding into the same few leaders, and the cost of monthly turnover.',
      assets: '9 sector ETFs (XLB, XLE, XLF, XLI, XLK, XLP, XLU, XLV, XLY)',
      entry:
        'On the first trading day of each month, among the 9 sector ETFs whose close is above their 200-day moving average, buy the 3 with the highest 6-month total return, equal-weighted.',
      exit: 'At each monthly rebalance, sell any holding no longer among the top 3, or no longer above its 200-day average.',
      frequency: every(1, 'months'),
      turnaround: unknown,
      dataRequirements: `Daily bars for the 9 sector ETFs with at least 200 days of history.`,
      usedBy: [],
      sources: [
        {
          title: 'Do Industries Explain Momentum?',
          citation: 'Moskowitz, T. J. and Grinblatt, M. (1999). Journal of Finance 54(4).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-09-dual-momentum',
    v1Number: 'SMS-0009',
    expectedNumber: 'S00009-SM',
    related: ['S00001-SD', 'S00002-SM', 'S00008-EM'],
    linkHints: ['dual momentum', '\\bgem\\b', '\\befa\\b'],
    input: {
      name: 'Dual momentum — SPY, EFA, AGG',
      category: 'momentum',
      tags: ['long-only', 'absolute momentum', 'relative momentum'],
      timeframeCode: 'M',
      assetClassCode: 'S',
      shortDescription:
        'Hold US stocks or international stocks, whichever has the higher 12-month return, only while that return beats bonds and zero; otherwise hold bonds.',
      longDescription:
        'Dual momentum combines relative momentum (pick the stronger of two equity markets) with absolute momentum (stay in equities only while they are trending up). The decisions rest on 12-month returns and are reviewed monthly, so the timeframe letter is months even though prices are observed daily.\n\nRisks: lag at turning points, a whipsaw year when markets chop, and dependence on a single lookback.',
      assets: 'SPY, EFA and AGG',
      entry:
        "Hold SPY when SPY's 12-month return is greater than EFA's, greater than AGG's and greater than 0; hold EFA when EFA's 12-month return beats SPY's, AGG's and 0; otherwise hold AGG.",
      exit: 'At each monthly review, switch to whichever asset the rule now picks.',
      frequency: every(1, 'months'),
      turnaround: unknown,
      dataRequirements: `Daily bars for SPY, EFA and AGG with at least 12 months of history.`,
      usedBy: [
        {
          who: 'Gary Antonacci',
          what: 'Published Global Equities Momentum (GEM), a dual momentum rule across US stocks, international stocks and bonds',
          evidence: 'book',
          source: 'Antonacci, G. (2014). Dual Momentum Investing. McGraw-Hill.',
        },
      ],
      sources: [
        { title: 'Dual Momentum Investing', citation: 'Antonacci, G. (2014). McGraw-Hill.' },
        {
          title: 'A Quantitative Approach to Tactical Asset Allocation',
          citation: 'Faber, M. T. (2007). Journal of Wealth Management.',
        },
      ],
    },
  },
  {
    seedKey: 'seed-10-covered-calls',
    v1Number: 'SMO-0010',
    expectedNumber: 'S00010-OM',
    related: ['S00011-OM'],
    linkHints: [],
    input: {
      name: 'Covered calls (BXM)',
      category: 'income_options',
      tags: ['needs-options', 'income'],
      timeframeCode: 'M',
      assetClassCode: 'O',
      shortDescription:
        'Hold the S&P 500 and sell a one-month at-the-money call against it every month, as the Cboe BXM index does.',
      longDescription:
        'Selling calls against a stock position turns part of the upside into steady option premium. The BXM benchmark holds the S&P 500 and writes a near-the-money one-month index call on each monthly expiration, holding it to expiry.\n\nRisks: the stock downside is kept in full while the upside is capped, so the strategy lags in strong rallies; results depend on option prices and execution costs.',
      assets: 'S&P 500 (index or SPY) plus monthly calls on it',
      entry:
        'On each monthly option expiration, sell a one-month call at the money against the held index position.',
      exit: 'Let the call expire or settle at the next monthly expiration, then write the next one.',
      frequency: every(1, 'months'),
      turnaround: every(1, 'months'),
      dataRequirements:
        'Not built: needs options as a tradable asset class (order entry and positions for option contracts), plus option chains for pricing. The app today reads option data as signals only.',
      usedBy: [
        {
          who: 'Cboe Global Markets',
          what: 'Publishes the Cboe S&P 500 BuyWrite Index (BXM), which follows this rule',
          evidence: 'public_statement',
          source: 'Cboe BXM index methodology, https://www.cboe.com/us/indices/benchmark_indices/',
        },
      ],
      sources: [
        {
          title: 'Return and Risk of CBOE Buy Write Monthly Index',
          citation: 'Whaley, R. E. (2002). Journal of Derivatives 10(2).',
        },
        {
          title: 'Cboe benchmark indices (BXM)',
          url: 'https://www.cboe.com/us/indices/benchmark_indices/',
        },
      ],
    },
  },
  {
    seedKey: 'seed-11-cash-secured-puts-wheel',
    v1Number: 'SMO-0011',
    expectedNumber: 'S00011-OM',
    related: ['S00010-OM'],
    linkHints: [],
    input: {
      name: 'Cash-secured puts / the Wheel',
      category: 'income_options',
      tags: ['needs-options', 'income'],
      timeframeCode: 'M',
      assetClassCode: 'O',
      shortDescription:
        'Sell one-month puts secured by cash; if assigned, hold the shares and sell calls on them until they are called away (the Wheel).',
      longDescription:
        'Selling a put secured by cash collects premium for agreeing to buy the stock at the strike. The Cboe PUT index does this monthly on the S&P 500. The Wheel extends it: when a put is assigned, hold the shares and sell covered calls until the shares are called away, then start selling puts again.\n\nRisks: large losses in a falling market (the put seller owns the decline below the strike), capped upside, and assignment and execution costs.',
      assets: 'S&P 500 (index or SPY) or single stocks, plus monthly options',
      entry:
        'On each monthly expiration, sell a one-month put at or near the money, keeping enough cash to buy the shares if assigned.',
      exit: 'Let the put expire; if assigned, hold the shares and sell monthly calls on them until they are called away.',
      frequency: every(1, 'months'),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs options as a tradable asset class with assignment handling. The app today reads option data as signals only.',
      usedBy: [
        {
          who: 'Cboe Global Markets',
          what: 'Publishes the Cboe S&P 500 PutWrite Index (PUT), which sells cash-secured monthly puts',
          evidence: 'public_statement',
          source: 'Cboe PUT index methodology, https://www.cboe.com/us/indices/benchmark_indices/',
        },
      ],
      sources: [
        {
          title: 'Cboe benchmark indices (PUT)',
          url: 'https://www.cboe.com/us/indices/benchmark_indices/',
        },
      ],
    },
  },
  {
    seedKey: 'seed-12-multi-factor',
    v1Number: 'SQS-0012',
    expectedNumber: 'S00012-SQ',
    related: ['S00002-SM', 'S00007-SY'],
    linkHints: ['multi.?factor', 'value.*momentum'],
    input: {
      name: 'Multi-factor — value + momentum, S&P 500, quarterly',
      category: 'multi_factor',
      tags: ['long-only', 'fundamentals', 'universe ranking', 'quarterly rebalance'],
      timeframeCode: 'Q',
      assetClassCode: 'S',
      shortDescription:
        'Each quarter, rank the S&P 500 on a combined value and momentum score and hold the best-ranked stocks equally weighted.',
      longDescription:
        "Value and momentum have tended to work at different times, so combining them smooths the ride compared with either alone. The strategy scores each S&P 500 member on a value measure from filings and on 12-month price momentum, combines the two ranks, and holds the top of the combined list until the next quarterly rebalance.\n\nRisks: both factors can disappoint together, crowding, and survivorship bias in back tests on today's members. The linked Strategy Lab definition sets the exact measures and number of holdings.",
      assets: 'S&P 500 stocks',
      entry:
        'On the first trading day of each quarter, buy the S&P 500 stocks with the best combined rank of value (earnings yield) and 12-month momentum, equal-weighted.',
      exit: 'At each quarterly rebalance, sell holdings that have dropped out of the top of the combined rank.',
      frequency: every(1, 'quarters'),
      turnaround: unknown,
      dataRequirements: `Point-in-time fundamentals from SEC filings and daily bars for every S&P 500 member with at least 13 months of history.`,
      usedBy: [
        {
          who: 'Clifford Asness, Tobias Moskowitz and Lasse Pedersen',
          what: 'Published value and momentum combined across asset classes',
          evidence: 'paper',
          source:
            'Asness, C. S., Moskowitz, T. J. and Pedersen, L. H. (2013). Value and Momentum Everywhere. Journal of Finance 68(3).',
        },
      ],
      sources: [
        {
          title: 'Value and Momentum Everywhere',
          citation:
            'Asness, C. S., Moskowitz, T. J. and Pedersen, L. H. (2013). Journal of Finance 68(3).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-13-carry',
    v1Number: 'SMA-0013',
    expectedNumber: 'S00013-AM',
    related: ['S00018-AM'],
    linkHints: [],
    input: {
      name: 'Carry — FX, commodities and bonds',
      category: 'carry',
      tags: ['needs-futures', 'needs-fx', 'long-short'],
      timeframeCode: 'M',
      assetClassCode: 'A',
      shortDescription:
        'Go long the assets with the highest carry (yield or roll return) and short those with the lowest, across currencies, commodity futures and bonds, rebalanced monthly.',
      longDescription:
        'Carry is what an asset earns if its price does not change: the interest-rate gap in currencies, the roll yield in commodity futures, the yield and roll-down in bonds. Assets with high carry have tended to outperform those with low carry within each asset class.\n\nRisks: sudden unwinds in crises (carry trades crash together), leverage, and the cost of futures roll and financing.',
      assets: 'Currency forwards, commodity futures and government bond futures',
      entry:
        'Each month, within each asset class, rank instruments by carry and go long the highest-carry third and short the lowest-carry third.',
      exit: 'At each monthly rebalance, close positions whose carry rank has left the long or short group.',
      frequency: every(1, 'months'),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs FX, futures and bond instruments (the app trades US stocks and ETFs only), futures roll data and short positions across asset classes.',
      usedBy: [
        {
          who: 'Ralph Koijen, Tobias Moskowitz, Lasse Pedersen and Evert Vrugt',
          what: 'Published carry returns across currencies, commodities, bonds and equities',
          evidence: 'paper',
          source:
            'Koijen, R. S. J., Moskowitz, T. J., Pedersen, L. H. and Vrugt, E. B. (2018). Carry. Journal of Financial Economics 127(2).',
        },
      ],
      sources: [
        {
          title: 'Carry',
          citation:
            'Koijen, R. S. J., Moskowitz, T. J., Pedersen, L. H. and Vrugt, E. B. (2018). Journal of Financial Economics 127(2).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-14-merger-arbitrage',
    v1Number: 'SMS-0014',
    expectedNumber: 'S00014-SM',
    related: ['S00015-AD'],
    linkHints: [],
    input: {
      name: 'Merger arbitrage / event-driven',
      category: 'event_driven',
      tags: ['needs-deal-events', 'long-short'],
      timeframeCode: 'M',
      assetClassCode: 'S',
      shortDescription:
        'After a takeover is announced, buy the target below the offer price (and short the acquirer in stock deals) to earn the spread when the deal closes.',
      longDescription:
        'An announced acquisition usually leaves the target trading somewhat below the offer, because the deal might fail. Merger arbitrage collects that spread across many deals. Positions are held for weeks to months until the deal closes or breaks; months is the nearest decision-timescale code.\n\nRisks: a broken deal can lose many times the expected spread, and losses cluster in market downturns, when deals fail together.',
      assets: 'US stocks that are targets (and acquirers) in announced deals',
      entry:
        'After a definitive deal announcement, buy the target; in a stock-for-stock deal also short the acquirer at the exchange ratio.',
      exit: 'Close when the deal completes, or at once if it is withdrawn or blocked.',
      frequency: perYear(12, 4, 24),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs a corporate deal-events feed (announced mergers, terms, status changes) and short selling.',
      usedBy: [
        {
          who: 'Mark Mitchell and Todd Pulvino',
          what: 'Published risk and return of merger arbitrage across US cash and stock deals',
          evidence: 'paper',
          source:
            'Mitchell, M. and Pulvino, T. (2001). Characteristics of Risk and Return in Risk Arbitrage. Journal of Finance 56(6).',
        },
      ],
      sources: [
        {
          title: 'Characteristics of Risk and Return in Risk Arbitrage',
          citation: 'Mitchell, M. and Pulvino, T. (2001). Journal of Finance 56(6).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-15-convertible-arbitrage',
    v1Number: 'SDA-0015',
    expectedNumber: 'S00015-AD',
    related: ['S00004-SD', 'S00014-SM'],
    linkHints: [],
    input: {
      name: 'Convertible arbitrage',
      category: 'pairs_stat_arb',
      tags: ['needs-bonds', 'long-short', 'hedged'],
      timeframeCode: 'D',
      assetClassCode: 'A',
      shortDescription:
        "Buy convertible bonds that look cheap and short the issuer's stock against them, re-hedging daily.",
      longDescription:
        "A convertible bond is a bond plus an option to convert into stock. When the option inside is priced cheaply, buying the bond and shorting the right amount of stock (delta hedging) isolates that mispricing and the bond's income. The hedge is adjusted daily as the stock moves.\n\nRisks: credit losses, liquidity crises when many funds sell at once, short-borrow recalls and leverage.",
      assets: "Convertible bonds and the issuers' common stock",
      entry:
        "Buy a convertible whose implied volatility is below the stock's expected volatility, and short the stock at the bond's delta.",
      exit: 'Unwind when the valuation gap closes, at conversion or maturity, or when credit worsens; re-hedge the stock short daily in between.',
      frequency: perYear(24, 6, 50),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs convertible bond prices and terms, a bond asset class, a convertible pricing model and short selling.',
      usedBy: [
        {
          who: 'Vikas Agarwal, William Fung, Yee Cheng Loon and Narayan Naik',
          what: 'Published the risk and return of convertible arbitrage using convertible bond market data',
          evidence: 'paper',
          source:
            'Agarwal, V., Fung, W. H., Loon, Y. C. and Naik, N. Y. (2011). Risk and Return in Convertible Arbitrage: Evidence from the Convertible Bond Market. Journal of Empirical Finance 18(2).',
        },
      ],
      sources: [
        {
          title:
            'Risk and Return in Convertible Arbitrage: Evidence from the Convertible Bond Market',
          citation:
            'Agarwal, V., Fung, W. H., Loon, Y. C. and Naik, N. Y. (2011). Journal of Empirical Finance 18(2).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-16-volatility-dispersion',
    v1Number: 'SDO-0016',
    expectedNumber: 'S00016-OD',
    related: ['S00006-SD', 'S00004-SD'],
    linkHints: [],
    input: {
      name: 'Volatility arbitrage / dispersion',
      category: 'volatility',
      tags: ['needs-options', 'long-short', 'correlation'],
      timeframeCode: 'D',
      assetClassCode: 'O',
      shortDescription:
        'Sell index option volatility and buy volatility on the index members, profiting when implied correlation is higher than what is realised.',
      longDescription:
        'Index options are usually priced as if the members will move together more than they end up doing. A dispersion trade sells index straddles and buys straddles on the members, delta-hedged daily, and earns that correlation premium when the members disperse.\n\nRisks: correlation spikes in sell-offs (all stocks fall together), heavy transaction costs across many option positions, and the need for daily hedging.',
      assets: 'S&P 500 index options and options on its larger members',
      entry:
        'When index implied correlation is high relative to realised correlation, sell index straddles and buy member straddles weighted to match, delta-hedged.',
      exit: 'Close at option expiry or when the correlation gap closes; re-hedge deltas daily in between.',
      frequency: every(1, 'months'),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs options as a tradable asset class with multi-leg option orders and daily delta hedging. Option chain data exists today for signals only.',
      usedBy: [
        {
          who: 'Joost Driessen, Pascal Maenhout and Grigory Vilkov',
          what: 'Published the correlation risk premium in index versus single-stock options',
          evidence: 'paper',
          source:
            'Driessen, J., Maenhout, P. J. and Vilkov, G. (2009). The Price of Correlation Risk: Evidence from Equity Options. Journal of Finance 64(3).',
        },
      ],
      sources: [
        {
          title: 'The Price of Correlation Risk: Evidence from Equity Options',
          citation:
            'Driessen, J., Maenhout, P. J. and Vilkov, G. (2009). Journal of Finance 64(3).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-17-market-making',
    v1Number: 'SSA-0017',
    expectedNumber: 'S00017-AS',
    related: [],
    linkHints: [],
    input: {
      name: 'Market making / HFT',
      category: 'market_making',
      tags: ['needs-tick-data', 'intraday'],
      timeframeCode: 'S',
      assetClassCode: 'A',
      shortDescription:
        'Quote both a bid and an ask continuously and earn the spread, adjusting quotes to keep inventory near flat.',
      longDescription:
        'A market maker posts buy and sell quotes around the current price and earns the bid–ask spread on round trips. Quotes are skewed away from the side where inventory is building, so the book stays close to flat. Decisions happen in seconds or less.\n\nRisks: adverse selection (trading against better-informed orders), inventory losses in fast moves, and a technology race on speed. Not realistic in a paper simulation without exchange-grade data.',
      assets: 'Liquid stocks, ETFs and futures',
      entry:
        'Continuously post a bid below and an ask above a fair-value estimate, sized and skewed by current inventory.',
      exit: 'Inventory is worked off by the opposite quotes; flatten at the end of the day or when inventory limits are hit.',
      frequency: every(1, 'seconds'),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs tick-level order book data, sub-second order handling and a venue connection the app does not have; out of scope for paper trading on bars.',
      usedBy: [],
      sources: [
        {
          title: 'High-frequency trading in a limit order book',
          citation: 'Avellaneda, M. and Stoikov, S. (2008). Quantitative Finance 8(3).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-18-global-macro',
    v1Number: 'SMA-0018',
    expectedNumber: 'S00018-AM',
    related: ['S00013-AM'],
    linkHints: [],
    input: {
      name: 'Global macro',
      category: 'macro',
      tags: ['discretionary', 'needs-futures', 'needs-fx'],
      timeframeCode: 'M',
      assetClassCode: 'A',
      shortDescription:
        'Take positions in currencies, rates, equity indices and commodities based on views about economies, policy and capital flows.',
      longDescription:
        "Global macro trades the big picture: interest-rate cycles, central bank policy, currency imbalances and growth surprises, expressed through liquid futures, forwards and index positions. It is often discretionary, so its rules are harder to write down than a systematic strategy's.\n\nRisks: being wrong on a large, leveraged view; event risk around policy decisions; results that depend heavily on the manager.",
      assets: 'Currencies, government bonds and rates, equity index futures and commodities',
      entry:
        'Open a position when a macro thesis (for example a policy shift or a currency misalignment) is supported by prices and positioning, sized to a risk budget.',
      exit: 'Close when the thesis plays out or is invalidated, or at a stop set by the risk budget.',
      frequency: perYear(6, 2, 12),
      turnaround: unknown,
      dataRequirements:
        'Not built: needs FX, futures and bond instruments, macroeconomic data, and a way to write discretionary theses as rules.',
      usedBy: [
        {
          who: 'George Soros',
          what: 'Described his macro trading approach and a live trading diary of the Quantum Fund',
          evidence: 'book',
          source: 'Soros, G. (1987). The Alchemy of Finance. Simon & Schuster.',
        },
      ],
      sources: [
        { title: 'The Alchemy of Finance', citation: 'Soros, G. (1987). Simon & Schuster.' },
      ],
    },
  },
];

/**
 * The whole seed catalogue in issue order: the 18 researched strategies
 * (ADR 0051), then the 13 short-term ones (seed extension 2, ADR 0055).
 */
export const STRATEGY_LIBRARY_SEED: readonly SeedEntry[] = [
  ...SEED_RESEARCHED,
  ...STRATEGY_LIBRARY_SEED_SHORT_TERM,
];

export type SeedOutcome = 'seeded' | 'extended' | 'already_seeded' | 'extension_blocked';

/**
 * Registers the seed catalogue in order, in one transaction, and checks every
 * number against the seed definition; any mismatch rolls the whole run back.
 * Run with the owner connection right after migrating. Idempotent.
 *
 * - An empty library gets all 31, then (unless `renumberFresh` is false) is
 *   moved to convention v2 in the same transaction, so a new install ends in
 *   the same state as a renumbered one.
 * - A library holding exactly the first seed entries and nothing else gets
 *   the missing tail (extension 2 on a library seeded with 18): they take
 *   the next numbers, under whichever convention is current.
 * - If other numbers were issued after the seeded ones, the tail cannot get
 *   its numbers: nothing is registered, a warning is logged and the outcome
 *   is `extension_blocked` (reported by library:renumber-v2; never renumbered).
 */
export async function seedStrategyLibrary(
  db: Database,
  options: { renumberFresh?: boolean | undefined } = {},
): Promise<SeedOutcome> {
  return db.transaction(async (tx) => {
    // Serialise concurrent seeders on the sequence row.
    const [seq] = await tx
      .select({ last: strategyLibrarySequence.lastIssued })
      .from(strategyLibrarySequence)
      .for('update');
    const last = seq?.last ?? 0;
    const seeded = await tx
      .select({ n: strategyLibraryEntries.registrationNumber, key: strategyLibraryEntries.seedKey })
      .from(strategyLibraryEntries)
      .where(sql`${strategyLibraryEntries.seedKey} is not null`);
    verify(seeded);
    const have = new Set(seeded.map((r) => r.key));
    const firstMissing = STRATEGY_LIBRARY_SEED.findIndex((e) => !have.has(e.seedKey));
    if (firstMissing === -1) return 'already_seeded';
    const missing = STRATEGY_LIBRARY_SEED.slice(firstMissing);
    if (missing.some((e) => have.has(e.seedKey)) || seeded.length !== firstMissing) {
      throw new Error('The Strategy Library seed is registered out of order; fix it by hand.');
    }
    if (last !== firstMissing) {
      if (firstMissing === 0) {
        throw new Error(
          `The Strategy Library has ${last} numbers issued and no seed entries; the seed must be registered first and whole.`,
        );
      }
      process.stderr.write(
        `Strategy Library: ${missing.length} seed entries (${missing[0]?.v1Number ?? '?'} on) not registered: ` +
          `${last} numbers are issued, not ${firstMissing}, so their numbers are taken. Nothing changed.\n`,
      );
      return 'extension_blocked';
    }
    for (const entry of missing) {
      // A newly seeded entry carries its v2 fields from the start (ADR 0055).
      const v2 = LIBRARY_V2_BACKFILL[entry.seedKey]?.values;
      const issued = await registerLibraryEntry(
        tx,
        null,
        { ...entry.input, ...v2 },
        { seedKey: entry.seedKey },
      );
      if (!seedNumberMatches(issued.registrationNumber, entry)) {
        throw new Error(
          `Seed ${entry.seedKey} was issued ${issued.registrationNumber}, expected ${entry.v1Number} (v1) or ${entry.expectedNumber} (v2)`,
        );
      }
    }
    await linkRelated(tx, missing);
    if (firstMissing === 0 && options.renumberFresh !== false) {
      await applyRenumberV2(tx);
      return 'seeded';
    }
    return firstMissing === 0 ? 'seeded' : 'extended';
  });
}

/**
 * A seed entry holds its theory number (v3), its v2 number while the library
 * is still on v2, or its v1 number while it is still on v1.
 */
function seedNumberMatches(number: string, entry: SeedEntry): boolean {
  if (number === entry.expectedNumber || number === v3NumberFor(entry.expectedNumber)) return true;
  return number === entry.v1Number && parseRegistrationNumber(number)?.layout === 'letters-first';
}

/** Found by seed key, never re-inserted: every seeded entry must hold its expected number. */
function verify(rows: { n: string; key: string | null }[]): void {
  for (const row of rows) {
    const entry = STRATEGY_LIBRARY_SEED.find((e) => e.seedKey === row.key);
    if (!entry) throw new Error(`Unknown seed key ${row.key ?? ''} holds ${row.n}`);
    if (!seedNumberMatches(row.n, entry)) {
      throw new Error(
        `Seed ${entry.seedKey} holds ${row.n}, expected ${v3NumberFor(entry.expectedNumber) ?? ''} (or ${entry.expectedNumber} before v3, ${entry.v1Number} before v2)`,
      );
    }
  }
}

/**
 * Related entries point both ways and forwards, so they are set after the
 * entries are registered. They are written in v2 and stored as each related
 * entry's current number (its v1 number while the library is still on v1).
 */
async function linkRelated(tx: Transaction, entries: readonly SeedEntry[]): Promise<void> {
  const rows = await tx
    .select({ n: strategyLibraryEntries.registrationNumber, key: strategyLibraryEntries.seedKey })
    .from(strategyLibraryEntries)
    .where(sql`${strategyLibraryEntries.seedKey} is not null`);
  const current = new Map(
    STRATEGY_LIBRARY_SEED.map((e) => [e.expectedNumber, rows.find((r) => r.key === e.seedKey)?.n]),
  );
  for (const entry of entries) {
    if (!entry.related.length) continue;
    const related = entry.related.map((n) => {
      const now = current.get(n);
      if (!now) throw new Error(`Seed ${entry.seedKey} relates to ${n}, which is not registered`);
      return now;
    });
    await tx
      .update(strategyLibraryEntries)
      .set({ relatedEntries: related })
      .where(sql`${strategyLibraryEntries.seedKey} = ${entry.seedKey}`);
  }
}

export interface SeedLinkMatch {
  seedKey: string;
  /** The seed entry's theory number (the backfill shows the entry's current one). */
  registrationNumber: string;
  name: string;
  /** The single strategy matched, or why none was. */
  result:
    | { kind: 'match'; strategyId: string; strategyName: string }
    | { kind: 'none' }
    | { kind: 'ambiguous'; candidates: string[] };
}

/**
 * Proposes which of a workspace's strategies each built seed entry links to,
 * by name. For each entry the first hint that matches exactly one strategy
 * not already taken wins; anything unclear is reported, never guessed.
 */
export function matchSeedLinks(
  workspace: readonly { id: string; name: string }[],
): SeedLinkMatch[] {
  const taken = new Set<string>();
  const out: SeedLinkMatch[] = [];
  for (const seed of STRATEGY_LIBRARY_SEED) {
    if (!seed.linkHints.length) continue;
    let result: SeedLinkMatch['result'] = { kind: 'none' };
    for (const hint of seed.linkHints) {
      const re = new RegExp(hint, 'i');
      const hits = workspace.filter((s) => !taken.has(s.id) && re.test(s.name));
      const [only] = hits;
      if (hits.length === 1 && only) {
        result = { kind: 'match', strategyId: only.id, strategyName: only.name };
        taken.add(only.id);
        break;
      }
      if (hits.length > 1 && result.kind === 'none') {
        result = { kind: 'ambiguous', candidates: hits.map((h) => h.name) };
      }
    }
    out.push({
      seedKey: seed.seedKey,
      registrationNumber: v3NumberFor(seed.expectedNumber) ?? seed.expectedNumber,
      name: seed.input.name,
      result,
    });
  }
  return out;
}
