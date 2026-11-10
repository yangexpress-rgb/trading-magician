# ADR 0070: Price charts move through time and compare symbols

- **Status:** accepted
- **Date:** 2026-11-10
- **Design refs:** design v1.2 rows N196–N198, open point O139. Extends ADR 0029 (price charts)

## Context

The Price charts page (ADR 0029) always showed a range ending today: there was no way to look
at a given day or week, to scroll the chart through time, or to put several stocks on one
chart. Yong: "when i display the price chart, i need to have more functionalities to select a
different date, or a different week, and be able to scroll left and right to move the chart on
time series. also the chart should allow me to stack multi stocks on one chart. Please refer to
trading view and learn the display capabilities." TradingView's chart offers a "go to date",
drag and wheel scrolling with history loaded as you scroll back, zoom, and Compare (other
symbols drawn as percent change from the left edge of the view).

## Decision

- **A chart can end on any past date (N196).** `POST /research/price-charts` takes an optional
  `end` New York date; the window is the range ending on that date (never after today), so the
  existing `from_date`/`to_date` columns carry it and no migration is needed. A recent chart is
  reused only for the same end date. 1D still keeps the last session in the window, so a
  weekend date shows the Friday before. The page's Date row steps the end back or forward by the
  range (1D by NYSE trading day, via `stepChartEnd`), takes a date, and returns to Latest. The
  date is in the address as `date=`.
- **Scrolling and zooming are on the client (N197).** The chart keeps a view (the time of its
  rightmost bar and how many bars it shows) over all bars loaded so far, so adding older bars in
  front never moves it. Drag, sideways swipe, Shift+wheel, the Earlier/Later buttons and the
  arrow keys past an edge scroll; Ctrl/⌘+wheel (a trackpad pinch), the −/+ buttons and keys zoom.
  A plain vertical wheel still scrolls the page. Once the person has moved the view and it comes
  within one screen of the oldest loaded bar, the next older stretch is fetched with the longest
  range its bars allow (`CHART_HISTORY_CHUNK`: 1W of 5-minute, 3M of hourly, 1Y of daily bars);
  a chart ending on an earlier date fetches newer stretches the same way until today. Nothing
  extra is fetched until the person moves the chart, so opening a chart costs the same feed
  requests as before. An empty older stretch marks the start of the feed's history. The price
  scale fits the bars in view; Reset view returns to the range chosen.
- **Compare (N198).** Up to four more symbols, picked by ticker (known ones at once, others
  through the same lookup as the stock picker). Each is fetched over the same stretches as the
  main symbol and lined up with it by bar start time. While comparing, all lines show percent
  change from their first close in view, on one axis (O139: no second price axis). Each symbol
  keeps a fixed colour slot while others come and go: series 1 (main) to 5, the validated
  categorical order (series 3 to 5 added to the theme, light and dark). A legend gives each
  symbol's close and change at the crosshair, the axis labels each line's last change, and the
  table adds a close column per symbol. The list is in the address as `compare=`.
- **Pending charts.** A chart plus four compared symbols, each fetching a stretch, can be ten
  requests at once, so the pending limit per tenant rises from 5 to 12.

## Consequences

- A person can reach any past day, week or month and keep scrolling back through the feed's
  history; each older stretch costs one bars request per symbol, inside the per-key budget
  (ADR 0052).
- The options cone shows only on the latest view and not while comparing.
- An index has daily bars only, so it shows "no prices" when compared on intraday bars (O139).
