# ADR 0098: Units on every value, and S numbers wherever a strategy is named

- **Status:** accepted
- **Date:** 2026-11-16
- **Design refs:** design v1.3 §5.1, §12.7, §13; N284, N285. Supersedes the "units in headers"
  part of ADR 0057 (O102). Requested by Yong on 2026-11-16 from the Performance tab: strategies
  there showed no S number, "Return on peak capital %" cells read −2.8 and "Net P/L $" cells read
  −1,081.98.

## Context

ADR 0057 (O102, 2026-11-08) put the unit of a money or percentage column in its header ("Net P/L
$", "Return %") and stripped it from each cell with `bare()`. Read on its own, a cell such as
−2.8 no longer says whether it is dollars, percent or a ratio, and other pages (stat cards,
sentences, detail lines) already showed "$" and "%" on the value, so the app read two ways.

Lab strategies have their own S numbers (ADR 0066), and Orders shows them (N246), but Performance,
notifications, theory pages, pickers and feed or broker warnings still named strategies by name
alone, and names repeat ("NKE-buy low", "Copy of …").

## Decision

- **N284: the unit rides on the value.** Every dollar amount shows "$" and every percentage "%"
  on the number itself: "−$1,081.98", "−2.8%". `bare()` and `apps/web/lib/units.ts` are gone;
  table headers drop the trailing " $" / " %" ("Net P/L", "Return on peak capital"), since the
  cells now carry it. Formatters that wrote bare numbers now add the unit: order prices
  (`formatPrice` in `apps/web/lib/order-text.ts`), screener price columns (`formatCell`), deal
  offers and spreads, EPS and earnings surprise, option strikes and the underlying price,
  custom-feed preview prices, risk-check figures in the order drawer (`riskFigure`: dollars,
  percent or seconds), and fill notifications ("at an average of $101.50"). Screener filter
  labels that already name a unit ("5-day change %") keep it. Counts, ratios, greeks and metric
  values of mixed units (RSI, z-scores) stay as they are.
- **N285: a strategy is named with its S number.** Where a table lists strategies, the number is
  its own **Number** column (Performance: Contribution by strategy, Trades, Open positions; a dash
  when a strategy has none). Elsewhere it goes before the name, "S00039-SD Earnings breakout": the
  Performance strategy filter, the Strategy to copy picker, theory pages' built strategies and the
  Strategy Lab link picker, the strategy page's start and stop confirmations, version pages,
  every notification title that names a strategy (started, stopped, paused, resumed, Entry or
  Exit triggered, loss limits, fills, plan pauses) and feed, route and broker-account warnings.
  Server text builds the label in SQL with `strategyLabelSql` (`packages/db/src/strategy-label.ts`,
  `concat_ws` of `lab_number` and `name`) or `strategyLabelOf` for rows already loaded. Theories
  keep their T numbers; Orders keeps `StrategyRef` (N246).

## Amendment (2026-11-16): gain and loss colours, no split numbers

- **N289.** Yong asked the same day that increases and gains read green and decreases and
  losses red, and that a number never wrap so its "−" lands on another line than the figure
  ("−" / "$1,032.08" in Contribution by strategy). `Signed` (`apps/web/components/signed.tsx`)
  colours a figure by its sign with `text-ok` / `text-danger` (`signTone`,
  `apps/web/lib/sign-tone.ts`) and keeps it on one line; numeric table cells are
  `whitespace-nowrap` in `@tm/ui`. Headline tiles carry the sign (`MetricTile.sign`, or `parts`
  for "realized / unrealized" and "average gain / loss"); a drawdown counts as a loss. Applied to
  Performance (tiles, Contribution by strategy and asset, Trades and their legs), back test tiles,
  runs, contributions and cycles, Strategy Lab's latest back test, earnings SUE and surprise,
  pattern occurrences, signed company figures and the price chart's compare readout (the
  Research change line and screener already did this). Zero and missing values stay in ink;
  colour is never the only cue, since the sign stays.

## Consequences

- Notifications already stored keep the text they were written with; new ones carry the number.
- No migration, no API shape change beyond the new `strategyNumber` fields on Performance
  summaries (`byStrategy`) and trades, which are additive.
- Theory revision notes ("The Strategy Lab strategy “…” now uses T…") are history and keep the
  name alone.
