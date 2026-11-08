import type { SeedEntry } from './library-seed';

/**
 * Seed extension 2 (ADR 0055): the 13 short-term / HFT strategies, sequence
 * 19–31, transcribed from Yong's "strategy-library-seed-extension-short-term"
 * file (Drive, 2026-11-08). B1 market making is already SSA-0017 / S00017-AS
 * and B7 momentum ignition is excluded on purpose (illegal manipulation).
 * All 13 are Not built. No performance figures are recorded as figures: the
 * report's decay and back test numbers stay in the long descriptions as prose
 * with their caveats. `usedBy` is empty where no published user is named.
 *
 * `v1Number` is the number each would have been issued under convention v1
 * (and is, on a library still on v1); `expectedNumber` is its v2 number.
 */
export const STRATEGY_LIBRARY_SEED_SHORT_TERM: readonly SeedEntry[] = [
  {
    seedKey: 'seed-19-intraday-momentum',
    v1Number: 'SNS-0019',
    expectedNumber: 'S00019-SN',
    related: ['S00002-SM', 'S00009-SM'],
    linkHints: [],
    input: {
      name: 'Intraday momentum — first half-hour predicts last half-hour',
      category: 'momentum',
      tags: ['intraday', 'time-series momentum', 'needs-intraday-bars'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Trade the last half-hour in the direction of the first half-hour return; flat by the close.',
      longDescription:
        'The tendency for the market\'s early-session return to predict its late-session return the same day. Gao, Han, Li and Zhou (2018) measure the first half-hour return from the previous close to 10:00 ET and trade in that direction for the last half-hour (15:30–16:00), flat by close. Proposed mechanisms: infrequent portfolio rebalancing and late-informed trading near the close; leveraged-ETF rebalancing is also cited.\n\nTreat as decayed, not as a live edge: an independent replication on SPY/QQQ/IWM/DIA 1-minute bars found the strategy net of a 2bp round-trip cost loses in every instrument and every sub-window (2014–26 panel average −2.30bp/day, win rate 43–49%), and SPY/DIA actually show slight reversal. A second replication found no effect on US indices, with the DAX/FTSE effect entirely in the overnight gap and gone since 2021. Much of the "intraday" effect was the gap, not the session.',
      assets: 'SPY (also QQQ, IWM, DIA in the paper)',
      entry:
        'At 15:30 ET, enter in the direction of the return from the previous close to 10:00 ET.',
      exit: 'Exit at the close (16:00 ET); flat overnight.',
      frequency: { kind: 'every', value: 1, unit: 'days' },
      turnaround: { kind: 'every', value: 30, unit: 'minutes' },
      dataRequirements:
        "Intraday bars (1-min or 30-min) for the traded ETF, plus the previous close. No tick, Level-2 or co-location for the 15:30-entry version. NOT runnable on daily bars: a daily-bar proxy (yesterday's return → today's close) is a different, untested rule.",
      usedBy: [
        {
          who: 'Gao, Han, Li and Zhou',
          what: 'Published the intraday momentum pattern (first-half-hour return predicts last-half-hour return) in SPY and 10 other heavily traded ETFs',
          evidence: 'paper',
          source:
            'Gao, L., Han, Y., Li, S. Z. and Zhou, G. (2018). Intraday Momentum: The First Half-Hour Return Predicts the Last Half-Hour Return. Journal of Financial Economics 129(2).',
        },
      ],
      sources: [
        {
          title: 'Intraday Momentum: The First Half-Hour Return Predicts the Last Half-Hour Return',
          citation:
            'Gao, L., Han, Y., Li, S. Z. and Zhou, G. (2018). Journal of Financial Economics 129(2).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-20-opening-range-breakout',
    v1Number: 'SNS-0020',
    expectedNumber: 'S00020-SN',
    related: ['S00005-SD'],
    linkHints: [],
    input: {
      name: 'Opening range breakout (ORB) — 5-minute range',
      category: 'breakout',
      tags: ['intraday', 'opening range', 'needs-intraday-bars'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Buy a break above (or short a break below) the high/low of the first 5 minutes after the open; flat by the close.',
      longDescription:
        "Define the high/low of the first N minutes after the 09:30 open; buy a break above, short a break below; flat by close. Canonical 5-minute version: range 09:30–09:35, stop order at the range high (long) / low (short), stop at the opposite extreme or a fraction of ATR, exit at close. Variants use 15/30/60-minute ranges. Toby Crabel popularised it; Arthur Merrill's earlier work is cited as a precursor.\n\nThe relative-volume filter did the work, not the breakout: in Zarattini, Barbon and Aziz (2024, 7,000+ US stocks 2016–23), plain 5-min ORB returned 29% total (3.2%/yr, Sharpe 0.48, hit ratio 41.4%) while the top-20 stocks by opening relative volume returned 1,637% total (41.6%/yr, Sharpe 2.81). The edge is concentrated in a few large winners (low win rate, long losing streaks). No audited live record exists.",
      assets: 'US stocks (universe scan) or QQQ/TQQQ',
      entry:
        'At 09:35 ET, buy on a break above the 09:30–09:35 range high, or short on a break below the range low.',
      exit: 'Exit at the close; stop at the opposite extreme of the opening range (or a fraction of ATR).',
      frequency: { kind: 'every', value: 1, unit: 'days' },
      turnaround: { kind: 'every', value: 3, unit: 'hours', low: 0.25, high: 6.5 },
      dataRequirements:
        '1-min or 5-min intraday bars + opening volume; the relative-volume filter needs a 14-day history of first-5-min volume per stock and a broad universe scan. No tick, Level-2 or co-location. NOT runnable on daily bars: daily bars cannot define a 5-minute range or time a 09:35 entry.',
      usedBy: [
        {
          who: 'Toby Crabel',
          what: 'Popularised the opening range breakout',
          evidence: 'book',
          source:
            'Crabel, T. (1990). Day Trading with Short Term Price Patterns and Price Action Strategies. Wiley.',
        },
        {
          who: 'Zarattini, Barbon and Aziz',
          what: 'Working paper backtesting the 5-min ORB on 7,000+ US stocks, 2016–23',
          evidence: 'paper',
          source: 'Zarattini, Barbon and Aziz (2024). Swiss Finance Institute / SSRN.',
        },
      ],
      sources: [
        {
          title: 'Day Trading with Short Term Price Patterns and Price Action Strategies',
          citation: 'Crabel, T. (1990). Wiley.',
        },
      ],
    },
  },
  {
    seedKey: 'seed-21-gap-and-go',
    v1Number: 'SNS-0021',
    expectedNumber: 'S00021-SN',
    related: ['S00026-SD'],
    linkHints: [],
    input: {
      name: 'Gap-and-go — overnight gap continuation',
      category: 'breakout',
      tags: ['intraday', 'overnight gap', 'needs-intraday-bars'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Trade continuation in the direction of the overnight gap, confirmed by the first intraday candle; flat by the close.',
      longDescription:
        "Trade continuation in the direction of the overnight gap (previous 16:00 close to 09:30 open), usually on a news or earnings catalyst. Two common rules: (i) futures — after a gap of at least 0.5%, wait for the first 5-minute candle to close in the gap direction, enter on a break of that candle's high/low; (ii) single-stock earnings — wait for the first 1-hour candle after an earnings gap, enter on continuation. The opposite trade, gap fade, is the contrarian version.\n\nNo peer-reviewed study of gap-and-go as a rule exists; practitioner backtests only, all unverified, no audited win rate. Gaps without a catalyst underperform, and gap-fill reversals (price returning to the previous close within the first hour) are the main failure. The academic anchor is PEAD (S00026-SD), not gap-and-go itself.",
      assets: 'E-mini futures (MES, MNQ, YM, RTY) or single stocks after earnings gaps',
      entry:
        "After a gap of at least 0.5% from the previous close, wait for the first 5-minute candle to close in the gap direction, then enter on a break of that candle's high (long) or low (short).",
      exit: "Flat by the close; stop at the confirmation candle's low/high; target 2R. Exit if price fills the gap within the first hour.",
      frequency: { kind: 'every', value: 1, unit: 'days' },
      turnaround: { kind: 'every', value: 3, unit: 'hours', low: 0.25, high: 6.5 },
      dataRequirements:
        'Previous close + open (daily bars identify the gap) + 1-min/5-min intraday bars to confirm and time entry + pre-market volume + news/earnings calendar. No tick, Level-2 or co-location. Daily bars can identify and score gaps but cannot execute the confirmation candle or the intraday exit.',
      usedBy: [],
      sources: [],
    },
  },
  {
    seedKey: 'seed-22-vwap-mean-reversion',
    v1Number: 'SNS-0022',
    expectedNumber: 'S00022-SN',
    related: ['S00003-SD'],
    linkHints: [],
    input: {
      name: 'VWAP mean reversion — fade the session VWAP',
      category: 'mean_reversion',
      tags: ['intraday', 'vwap', 'needs-intraday-bars', 'needs-volume'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Fade a stretch far from the session VWAP, targeting a return to VWAP; flat by the close.',
      longDescription:
        'VWAP is the cumulative volume-weighted average price since the session open (reset 09:30 ET). The mean-reversion rule fades a stretch far from VWAP, targeting a return to it; the opposite use is trend (only trade in the direction of price relative to VWAP), mainly a filter and execution benchmark.\n\nNo peer-reviewed evidence that fading VWAP deviations is profitable. A walk-forward backtest (SPY, 2022–25, 5bp friction) found VWAP reversion Sharpe −1.89; a gold 5-minute VWAP-band backtest lost $0.26/oz per trade after costs (~22% winners). Regime failure is the core problem: on trend days price rides away from VWAP and fading loses repeatedly. Costs dominate because targets are small. No named firm publishes a standalone VWAP mean-reversion P&L; institutional desks use VWAP as a benchmark (Harris 2003: ~30–40% of institutional flow targets VWAP).',
      assets: 'SPY (or any liquid stock/ETF with volume)',
      entry:
        'On 5-minute bars, buy when price closes 2–3 standard deviations below the session VWAP; mirror for shorts.',
      exit: 'Target the VWAP itself; stop just beyond 3 standard deviations. Flat by the close — the signal dies when VWAP resets.',
      frequency: { kind: 'every', value: 1, unit: 'days' },
      turnaround: { kind: 'every', value: 2, unit: 'hours', low: 0.25, high: 4 },
      dataRequirements:
        'Intraday bars with volume (1-min or 5-min) to compute running VWAP; ideally the full-session volume profile. No tick, Level-2 or co-location for the 5-min version. NOT runnable on daily bars: session VWAP cannot be computed live from daily bars.',
      usedBy: [],
      sources: [
        { title: 'Trading and Exchanges', citation: 'Harris, L. (2003). Oxford University Press.' },
      ],
    },
  },
  {
    seedKey: 'seed-23-scalping',
    v1Number: 'SNS-0023',
    expectedNumber: 'S00023-SN',
    related: ['S00022-SN'],
    linkHints: [],
    input: {
      name: 'Scalping — seconds to minutes, many trades a day',
      category: 'other',
      tags: ['intraday', 'scalping', 'needs-intraday-bars', 'needs-tick-data'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Take a few ticks (typically 0.1–1%) on a short-term signal, exit in seconds to minutes, repeat many times a day.',
      longDescription:
        'A style, not one rule: enter on a short-term signal, take a few ticks, exit in seconds to minutes, repeat many times a day. Sub-types include momentum scalps (bull-flag break on 1-minute bars), VWAP scalps and Level-2 / tape-reading scalps.\n\nNo study measures scalpers alone and no audited win rate exists. Population evidence for the closest group (day traders): Barber, Lee, Liu and Odean (Taiwan, 1992–2006, complete exchange records) found under 1% predictably and reliably profitable net of fees; Chague, De-Losso and Giovannetti (Brazil, 19,646 new index-futures day traders, 2013–15) found 97% of those persisting over 300 sessions lost money. Break-even arithmetic: at 1:1 risk/reward with a 1-pip round-trip cost on a 5-pip target, the break-even win rate is about 59–67%. Costs dominate because targets are a few ticks.',
      assets: 'Liquid stocks / E-mini futures (ES, NQ)',
      entry:
        'On 1-minute bars, enter on a short-term signal (e.g. a bull-flag breakout), target 1–2× the flag height or a fixed few ticks.',
      exit: 'Stop a few ticks beyond the flag; exit on a time-stop (5–30 minutes) if neither target nor stop hits.',
      frequency: { kind: 'per', value: 20, unit: 'days', low: 10, high: 50 },
      turnaround: { kind: 'every', value: 5, unit: 'minutes', low: 0.5, high: 30 },
      dataRequirements:
        '1-min bars minimum; tick data and Level-2 for tape-reading variants. Low-latency execution matters because targets are a few ticks. NOT runnable on daily bars: a daily bar contains hundreds of scalps.',
      usedBy: [],
      sources: [
        {
          title: 'Day-trader profitability (Taiwan complete exchange records, 1992–2006)',
          citation: 'Barber, B., Lee, Y.-T., Liu, Y.-J. and Odean, T.',
        },
      ],
    },
  },
  {
    seedKey: 'seed-24-intraday-pairs',
    v1Number: 'SNS-0024',
    expectedNumber: 'S00024-SN',
    related: ['S00004-SD'],
    linkHints: [],
    input: {
      name: 'Intraday statistical arbitrage / pairs — SPY vs QQQ',
      category: 'pairs_stat_arb',
      tags: ['intraday', 'pairs trading', 'statistical arbitrage', 'needs-intraday-bars'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Trade the spread between two correlated instruments on 1-minute bars, betting it reverts to its mean within minutes.',
      longDescription:
        'Trade the spread between two cointegrated or correlated instruments (e.g. SPY vs QQQ, or two stocks), betting the spread reverts to its mean. Spread = log(P1) − β·log(P2), β from cointegration, a rolling regression or a Kalman filter. The daily version of this rule is S00004-SD; this entry is the intraday version (reversion in 10–30 minutes on SPY/QQQ).\n\nDecay is the story: Gatev et al. found ~11%/yr on US stocks 1962–2002 and noted the decline after 1990; with costs added the rule is largely unprofitable after 2002. An independent replication on 36 sector-ETF pairs (daily, 1999–2026, 5bp/leg) found 2010–19: −0.50%/yr and 2020–26: −1.31%/yr — convergence still happens, but divergences no longer exceed round-trip cost. No audited live win rate for a retail intraday pairs strategy exists.',
      assets: 'SPY vs QQQ (or two correlated stocks)',
      entry:
        "Enter when the spread's z-score (30-minute lookback) exceeds ±1.5 standard deviations: long the cheap leg, short the rich leg.",
      exit: 'Exit when the z-score falls below 0.5 or crosses zero, or on a time-stop.',
      frequency: { kind: 'per', value: 3, unit: 'days', low: 1, high: 10 },
      turnaround: { kind: 'every', value: 20, unit: 'minutes', low: 10, high: 30 },
      dataRequirements:
        '1-min bars for both legs, synchronised timestamps; short borrow for the short leg. No tick, Level-2 or co-location for the slow version; the fast version needs them. The daily version runs on daily bars and is S00004-SD.',
      usedBy: [
        {
          who: 'Gatev, Goetzmann and Rouwenhorst',
          what: 'Documented pairs trading on US stocks 1962–2002 (~11%/yr, declining after 1990)',
          evidence: 'paper',
          source:
            'Gatev, E., Goetzmann, W. N. and Rouwenhorst, K. G. (2006). Pairs Trading: Performance of a Relative-Value Arbitrage Rule. Review of Financial Studies 19(3).',
        },
        {
          who: 'Avellaneda and Lee',
          what: 'ETF statistical arbitrage at intraday resolution',
          evidence: 'paper',
          source:
            'Avellaneda, M. and Lee, J.-H. (2010). Statistical Arbitrage in the U.S. Equities Market. Quantitative Finance 10(7).',
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
    seedKey: 'seed-25-news-reaction',
    v1Number: 'SNS-0025',
    expectedNumber: 'S00025-SN',
    related: ['S00026-SD'],
    linkHints: [],
    input: {
      name: 'News reaction — trade the repricing after a macro release',
      category: 'event_driven',
      tags: ['news', 'macro releases', 'intraday', 'needs-tick-data'],
      timeframeCode: 'N',
      assetClassCode: 'S',
      shortDescription:
        'Trade the repricing in the seconds after a scheduled macro release (CPI, NFP, FOMC) from machine-readable news feeds.',
      longDescription:
        'At 08:30 ET (CPI/NFP) or 14:00 ET (FOMC statement), machine-readable feeds are parsed and algos reprice in milliseconds; market makers withdraw liquidity about 2 minutes before the print. A retail trader reacting to a headline on a screen is trading after the repricing. The slower retail variant — wait 15–30 minutes for the first wave to pass, then trade the M15/H1 close — is a different, slower rule with no published audited record. No named firm publishes this as a standalone strategy; the edge is infrastructure.',
      assets: 'US equities / index futures around CPI, NFP, FOMC releases',
      entry:
        'On a scheduled release, enter in the direction of the machine-readable surprise within seconds of the print.',
      exit: 'Exit within minutes as the repricing completes; the slower variant waits 15–30 minutes for the first wave to pass, then trades the M15/H1 close.',
      frequency: { kind: 'per', value: 3, unit: 'months', low: 1, high: 8 },
      turnaround: { kind: 'every', value: 5, unit: 'minutes', low: 0.5, high: 30 },
      dataRequirements:
        'Machine-readable news wire (paid retail at best, institutional-only for the fastest wires) + tick data + co-location for the fast version. NOT runnable on daily bars. The slower 15–30-minute variant needs 15-minute bars.',
      usedBy: [],
      sources: [],
    },
  },
  {
    seedKey: 'seed-26-pead',
    v1Number: 'SDS-0026',
    expectedNumber: 'S00026-SD',
    related: ['S00025-SN', 'S00014-SM'],
    linkHints: [],
    input: {
      name: 'Post-earnings announcement drift (PEAD) — SUE deciles',
      category: 'event_driven',
      tags: ['earnings', 'post-earnings drift', 'needs-earnings-data'],
      timeframeCode: 'D',
      assetClassCode: 'S',
      shortDescription:
        'Buy stocks that beat earnings expectations and short those that miss; hold ~60 trading days for the drift.',
      longDescription:
        'Stocks that beat earnings expectations keep drifting up (and missers keep drifting down) for about 60 trading days after the announcement. Sort stocks by standardized unexpected earnings (SUE = actual minus expected, normalised); go long top-decile SUE, short bottom-decile; hold about 60 trading days until the next quarter. Entry is at or after the announcement close; no intraday timing.\n\nBernard and Thomas (1974–86) measured a hedge return of about 4.2% over 60 trading days, top-minus-bottom SUE decile, positive in 41 of 48 quarters — before costs. Decay: later studies find the drift much smaller in recent decades and weak or absent among large liquid US stocks; a 2026 working paper found the residual 60-day spread statistically insignificant after factor adjustment. This is the second Part A strategy that runs on daily bars, subject to sourcing SUE data — consensus estimates are the bottleneck (I/B/E/S, Zacks, FactSet are paid).',
      assets: 'US stocks around earnings announcements',
      entry:
        'At or after the announcement close, go long top-decile SUE stocks and short bottom-decile SUE stocks.',
      exit: "Hold about 60 trading days (until the next quarter's announcement), then rebalance.",
      frequency: { kind: 'every', value: 1, unit: 'quarters' },
      turnaround: { kind: 'every', value: 60, unit: 'days' },
      dataRequirements:
        'Daily bars + earnings dates + analyst consensus estimates (SUE needs expected EPS) + actual EPS. Consensus data is the bottleneck (I/B/E/S, Zacks, FactSet — paid); earnings dates + actuals are free. Runs on daily bars once SUE data is sourced.',
      usedBy: [
        {
          who: 'Ball and Brown',
          what: 'First documented post-earnings announcement drift (261 NYSE firms, 1946–66)',
          evidence: 'paper',
          source:
            'Ball, R. and Brown, P. (1968). An Empirical Evaluation of Accounting Income Numbers. Journal of Accounting Research 6(2).',
        },
        {
          who: 'Bernard and Thomas',
          what: 'Measured the 60-day drift: about 4.2% top-minus-bottom SUE decile, 1974–86',
          evidence: 'paper',
          source: 'Bernard, V. L. and Thomas, J. K. (1989, 1990). Journal of Accounting Research.',
        },
      ],
      sources: [
        {
          title: 'An Empirical Evaluation of Accounting Income Numbers',
          citation: 'Ball, R. and Brown, P. (1968). Journal of Accounting Research 6(2).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-27-latency-arbitrage',
    v1Number: 'SSA-0027',
    expectedNumber: 'S00027-AS',
    related: ['S00017-AS', 'S00030-AS'],
    linkHints: [],
    input: {
      name: 'Latency arbitrage — ES vs SPY, milliseconds',
      category: 'other',
      tags: ['hft', 'latency arbitrage', 'needs-colocation', 'needs-tick-data'],
      timeframeCode: 'S',
      assetClassCode: 'A',
      shortDescription:
        "Trade a price change in one venue before slower participants' quotes in a related venue have updated.",
      longDescription:
        'The purest HFT arbitrage: profit from symmetrically observed public information arriving at different times. Watch ES (E-mini S&P 500, Chicago) and SPY (New Jersey) — nearly perfectly correlated over minutes, uncorrelated over milliseconds. When ES jumps, immediately buy SPY (or sell ES) against stale SPY quotes, before SPY reprices; exit when the two re-align. Same logic across exchanges (same stock, different venue) and across related products (futures → ETF → constituents → options).\n\nBudish, Cramton and Shim (ES–SPY, 2005–11): the median arbitrage window shrank from 97ms (2005) to 7ms (2011) while profitability per opportunity stayed constant — "the arms race does not affect the size of the prize, it just raises the bar for how fast one has to be"; total ES–SPY prize about $75m/yr. Aquilina, Budish and O\'Neill (LSE): 537 latency races per FTSE 100 stock per day, the winner beating the first loser by 5–10 microseconds; the top 3 firms won about 55% of races. If you are not first you are the counterparty being arbitraged. No retail-accessible version exists; the prize goes to the fastest few.',
      assets:
        'ES futures vs SPY; same stock across venues; futures vs ETF vs constituents vs options',
      entry:
        'When the lead market jumps, immediately buy (or sell) the lagging related market against its stale quotes.',
      exit: 'Unwind as soon as the slow leg catches up and the two re-align (milliseconds).',
      frequency: { kind: 'per', value: 500, unit: 'days', low: 100, high: 1000 },
      turnaround: { kind: 'every', value: 0.01, unit: 'seconds', low: 0.001, high: 0.1 },
      dataRequirements:
        'Direct feeds from every venue, tick/message-level, GPS-synchronised timestamps, microwave/millimetre-wave links, FPGA feed handlers, kernel bypass. Co-location + private networks ARE the strategy. INSTITUTIONAL-ONLY. NOT runnable on daily bars — or on any retail data.',
      usedBy: [
        {
          who: 'Budish, Cramton and Shim',
          what: 'Documented the ES–SPY latency arbitrage and the shrinking arbitrage window (97ms in 2005 → 7ms in 2011)',
          evidence: 'paper',
          source:
            'Budish, E., Cramton, P. and Shim, J. (2015). The High-Frequency Trading Arms Race: Frequent Batch Auctions as a Market Design Response. Quarterly Journal of Economics 130(4).',
        },
      ],
      sources: [
        {
          title:
            'The High-Frequency Trading Arms Race: Frequent Batch Auctions as a Market Design Response',
          citation:
            'Budish, E., Cramton, P. and Shim, J. (2015). Quarterly Journal of Economics 130(4).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-28-order-book-imbalance',
    v1Number: 'SSS-0028',
    expectedNumber: 'S00028-SS',
    related: ['S00017-AS'],
    linkHints: [],
    input: {
      name: 'Order-book imbalance / order-flow trading',
      category: 'market_making',
      tags: ['hft', 'order-book imbalance', 'order flow', 'needs-colocation', 'needs-tick-data'],
      timeframeCode: 'S',
      assetClassCode: 'S',
      shortDescription:
        'Trade in the direction of the bid/ask size imbalance at the top of the book, seconds ahead of the next mid-price move.',
      longDescription:
        'Use the imbalance between bid and ask size (and order-flow events) at the top of the book as a seconds-ahead predictor of the next mid-price move. Resting imbalance I = (bid size − ask size) / (bid size + ask size), range −1 to +1; I near +1 means the mid is likely to tick up. Order-flow imbalance (OFI, Cont, Kukanov and Stoikov 2014) is the net signed flow from all top-of-book events — limit-order additions, cancellations and trades on both sides — aggregated over a short interval.\n\nCont et al. found price change over short intervals is approximately linear in OFI, with slope inversely proportional to book depth — a strong, robust statistical relationship, not a published P&L. No audited trading record, win rate or Sharpe for a standalone imbalance strategy was found; a statistical relationship in price changes is not a tradeable edge after spread, fees and slippage. Signal half-life is about seconds. Resting size can be cancelled instantly (flickering liquidity) or posted deliberately to mislead (spoofing/layering — illegal). Every HFT market maker uses imbalance as a quoting/skew input.',
      assets: 'Liquid US stocks (top of book)',
      entry:
        'Enter (marketable order or aggressive limit) when |OFI| relative to depth is large, in the imbalance direction.',
      exit: 'Exit seconds later when the mid moves or the imbalance flips.',
      frequency: { kind: 'per', value: 100, unit: 'days', low: 10, high: 1000 },
      turnaround: { kind: 'every', value: 5, unit: 'seconds', low: 1, high: 30 },
      dataRequirements:
        'Full Level-2 order book, message-level (every add/cancel/trade, not snapshots), tick data. Co-location to act before the imbalance decays. INSTITUTIONAL-ONLY (full-depth message data = TAQ / direct feeds, $25k+/yr class; retail Level-2 snapshots are too slow and coarse). NOT runnable on daily bars.',
      usedBy: [
        {
          who: 'Cont, Kukanov and Stoikov',
          what: 'Showed price change over short intervals is approximately linear in order-flow imbalance (50 US stocks, NYSE TAQ)',
          evidence: 'paper',
          source:
            'Cont, R., Kukanov, A. and Stoikov, S. (2014). The Price Impact of Order Book Events. Journal of Financial Econometrics 12(1).',
        },
      ],
      sources: [
        {
          title: 'The Price Impact of Order Book Events',
          citation:
            'Cont, R., Kukanov, A. and Stoikov, S. (2014). Journal of Financial Econometrics 12(1).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-29-rebate-trading',
    v1Number: 'SSS-0029',
    expectedNumber: 'S00029-SS',
    related: ['S00017-AS'],
    linkHints: [],
    input: {
      name: 'Rebate trading — maker rebates inside market making',
      category: 'market_making',
      tags: ['hft', 'maker rebate', 'market making', 'needs-colocation'],
      timeframeCode: 'S',
      assetClassCode: 'S',
      shortDescription:
        'Earn the exchange maker rebate on filled passive limit orders, as a component of market-making P&L — not a standalone signal.',
      longDescription:
        'Not a standalone signal: earn the exchange maker rebate (a small payment per share for posting a resting limit order that is filled) as a component of market-making P&L. Under maker–taker pricing, makers are paid and takers are charged; some venues invert this (taker–maker). The strategy is to maximise filled passive volume while minimising adverse selection — i.e. it IS market making, with the rebate as a subsidy that can turn a breakeven spread trade profitable.\n\nPure "rebate arbitrage" (posting quotes solely to collect rebates, with no view on price) only works at HFT scale and speed. The rebate is fractions of a cent per share, so profitability requires millions of fills a day; a retail trader posting passive orders earns the same nominal rebate but pays it back many times over in adverse selection (being filled when the price moves away). No isolated, audited rebate-trading P&L exists — rebates are a line inside market-making revenue.',
      assets: 'Liquid US stocks on rebate-paying venues',
      entry: 'Post passive limit orders on rebate-paying venues; each fill earns spread + rebate.',
      exit: 'Each fill is closed as part of the market-making inventory cycle; the position is the quote, not a held trade.',
      frequency: { kind: 'per', value: 100000, unit: 'days', low: 10000, high: 1000000 },
      turnaround: { kind: 'every', value: 5, unit: 'seconds', low: 1, high: 60 },
      dataRequirements:
        'Same as market making: Level-2, direct feeds, co-location, plus venue fee schedules (which change) and smart order routing across venues. INSTITUTIONAL-ONLY as a profitable strategy (the rebate schedule itself is public). NOT runnable on daily bars.',
      usedBy: [],
      sources: [],
    },
  },
  {
    seedKey: 'seed-30-index-etf-arbitrage',
    v1Number: 'SSA-0030',
    expectedNumber: 'S00030-AS',
    related: ['S00027-AS'],
    linkHints: [],
    input: {
      name: 'Index / ETF arbitrage — basis and creation/redemption',
      category: 'pairs_stat_arb',
      tags: ['arbitrage', 'etf', 'basis', 'needs-colocation', 'needs-tick-data'],
      timeframeCode: 'S',
      assetClassCode: 'A',
      shortDescription:
        'Exploit price gaps between an index and its derivatives/basket: futures vs basket (basis) or ETF vs its intraday NAV, via creation/redemption.',
      longDescription:
        'Two forms. (a) Cash–futures (basis) arbitrage: fair value of an index future = spot × (1 + financing − dividends) to expiry. If futures trade rich vs fair value, short futures and buy the basket (or the ETF); if cheap, buy futures and short the basket. Convergence at expiry (or when the basis normalises) realises the spread. (b) ETF arbitrage: if an ETF trades at a premium to its intraday indicative NAV (iNAV), an Authorized Participant (AP) creates new ETF shares by delivering the basket and sells them; at a discount, the AP redeems ETF shares for the basket. Non-APs replicate approximately by trading ETF vs futures/basket.\n\nNo standalone audited P&L is published — it is desk-level activity inside market-making/prop revenue. The economics are visible in the absence of persistent premiums: liquid ETFs (SPY, QQQ) trade within a few basis points of iNAV almost always, because AP arbitrage closes gaps in seconds to minutes. That tightness IS the evidence the edge is competed away for anyone without AP status and speed. In stressed markets APs step back and premiums/discounts gap (e.g. fixed-income ETFs in March 2020).',
      assets: 'Index futures vs the underlying basket; ETF vs iNAV/basket (AP creation/redemption)',
      entry:
        'If futures trade rich vs fair value, short futures and buy the basket (or the ETF); if cheap, buy futures and short the basket. If an ETF trades at a premium to iNAV, create shares by delivering the basket and sell them; at a discount, redeem.',
      exit: 'Close at expiry or when the basis normalises / the premium closes.',
      frequency: { kind: 'per', value: 10, unit: 'days', low: 1, high: 100 },
      turnaround: { kind: 'every', value: 60, unit: 'minutes', low: 1, high: 2880 },
      dataRequirements:
        'Real-time iNAV, basket composition (published daily), futures prices, borrow for short legs, AP agreement with the issuer (for creation/redemption). Tick data + co-location for the fast basis trade. Daily data suffices to OBSERVE premiums after the fact. NOT runnable as a trade on daily bars (cannot create/redeem, cannot trade futures–basket intraday); daily premium/discount to NAV is computable from daily bars as a screen only.',
      usedBy: [],
      sources: [
        {
          title:
            'The High-Frequency Trading Arms Race: Frequent Batch Auctions as a Market Design Response',
          citation:
            'Budish, E., Cramton, P. and Shim, J. (2015). Quarterly Journal of Economics 130(4).',
        },
      ],
    },
  },
  {
    seedKey: 'seed-31-triangular-arbitrage',
    v1Number: 'SSF-0031',
    expectedNumber: 'S00031-FS',
    related: ['S00027-AS'],
    linkHints: [],
    input: {
      name: 'Triangular arbitrage (FX) — cross-rate parity',
      category: 'other',
      tags: ['arbitrage', 'fx', 'needs-colocation', 'needs-tick-data'],
      timeframeCode: 'S',
      assetClassCode: 'F',
      shortDescription:
        'Exploit inconsistency among three FX pairs: EUR/USD × USD/JPY should equal EUR/JPY; trade all three legs at once when it does not.',
      longDescription:
        'Exploit inconsistency among three FX pairs: e.g. EUR/USD × USD/JPY should equal EUR/JPY; if it does not (beyond fees), trade all three legs simultaneously to lock the difference.\n\nThe mechanism is an identity (cross-rate parity), so opportunities are by construction tiny and fleeting — practitioner sources agree they "last milliseconds" and are "fully automated" in modern venues. Leg risk is the core failure: one leg fails to fill or reprices between legs and the "risk-free" trade becomes a directional bet. Retail FX brokers\' spreads alone exceed typical mispricings. No audited record exists; any retail "triangular arbitrage bot" win-rate claim is unverified marketing.',
      assets: 'EUR/USD, USD/JPY, EUR/JPY (or any FX triplet) on one venue',
      entry:
        'When the implied cross differs from the quoted cross by more than spread + fees, execute all three legs at once in the right notionals.',
      exit: 'Flat once all three legs print — a single atomic round trip, not a held position.',
      frequency: { kind: 'per', value: 100, unit: 'days', low: 10, high: 1000 },
      turnaround: { kind: 'every', value: 0.01, unit: 'seconds', low: 0.001, high: 0.1 },
      dataRequirements:
        'Real-time quotes on three pairs from the same venue (or across venues), tick-level, with simultaneous execution capability. Co-location / low-latency connectivity to the FX venue. INSTITUTIONAL-ONLY for the executable version; cross-rates are observable free/retail, but observing is not trading them. NOT runnable on daily bars: a daily bar cannot contain a millisecond mispricing.',
      usedBy: [],
      sources: [],
    },
  },
];
