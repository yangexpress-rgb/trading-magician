# ADR 0101: Watch list with live prices

- **Status:** accepted
- **Date:** 2026-11-17
- **Design refs:** design v1.3 §14.1a; N292. Requested by Yong on 2026-11-17: "build 'watch list'
  in the app, with a simple and direct view of real time changes by asset", with a screenshot of a
  watch list in groups (Indices, Stocks) showing Last, Chg and Chg% per symbol.

## Context

The app could chart one symbol at a time and screen the market, but nothing showed a handful of
chosen symbols moving together. Prices reach the app only through the worker, which holds the feed
keys (ADR 0015); the web app cannot call Alpaca itself. The admin's shared Alpaca key carries most
members' traffic and has a per-key request budget (ADR 0052) that strategies and back tests share.
Alpaca has no index quotes, and Cboe's delayed quotes may not be shown to users (ADR 0048).

## Decision

- **Place.** A new Quantitative Research tab, **Watch list** (`/research/watch-list`), after Price
  charts. A row opens the symbol's price chart (registered first through the person's feed when it
  is not yet).
- **Lists.** Each person has groups (name up to 40 characters, ordered, folded open or shut) of
  symbols (ordered, at most 100 symbols and 20 groups). Tables `watch_list_group`,
  `watch_list_item` and `watch_list_view` (migration 0100), each the person's own under row-level
  security and cleared by the account purge. A symbol is stored as a ticker, with its instrument
  and name when the feed found it, so the starting list needs no lookups. The first visit starts
  the list with **Indices** (SPY, QQQ, DIA, IWM, VIX) and **Stocks** (AAPL, TSLA, NFLX, NKE); a
  list emptied later stays empty. Symbols are added by ticker or company name through the same
  lookup as Price charts; without a US stock price feed the ticker is kept as typed.
- **Indices.** The S&P 500, Nasdaq 100, Dow and Russell 2000 are followed through the ETFs that
  track them (SPY, QQQ, DIA, IWM): their Chg% moves with the index and Alpaca prices them. The VIX
  is the real index from Cboe's free end-of-day history, already shown on Price charts (ADR 0042),
  marked **D** (daily close) and shown in points, not dollars.
- **Prices.** A worker job (`apps/worker/src/watch-quotes.ts`) checks every second which lists were
  open in the last 30 seconds (`watch_list_demand`, a security-definer function) and prices their
  symbols every 5 seconds from 4 AM to 8 PM New York on trading days, once a minute otherwise. Each
  person's symbols go through their own US stock price feed or the admin's shared one (N237);
  people on the same feed share one Alpaca snapshots request per 100 symbols, so a few open lists
  cost about 12 requests a minute on the shared key. Last is the latest IEX trade (else the quote
  midpoint); Chg and Chg% are measured from the previous session's close (the daily bar before
  today's, or the latest daily bar before today's first trade). Index closes are asked for at most
  every 10 minutes. Prices are written once per symbol to `watch_quote`, public market data the
  worker writes and the app reads, like the 52-week ranges (ADR 0099).
- **Page.** The page asks for the list every 2 seconds while the tab is visible; each ask also marks
  the list as open. Last carries $ (an index's does not), Chg "+$2.35" or "−$0.83", Chg% "+0.24%";
  gains green, losses red, signs never wrapped (N284, N289). The digits of Last that just moved
  light up green or red for a moment. A footnote says when prices were updated, that Alpaca's free
  feed has IEX trades only, and what the ETF stand-ins and D mean.

## Consequences

- No new provider, key or environment variable; nothing is fetched while nobody has a list open.
- IEX-only last prices can lag the consolidated tape for thinly traded names; the footnote says so.
- Index levels (SPX 7,332) are not shown, only their ETFs' prices. Showing real index levels needs
  a licensed index feed; it can be added as another `watch` provider without changing the page.
- A later side panel (watch list beside any page) can reuse the same endpoint and component.

## Amendment (2026-11-17, N293)

At Yong's request after trying it: each group is its own named **section** (a card with its name,
fold, + and ⋯), the separate "Add a symbol" box at the top is gone (each section's **+** opens its
own add box), and the column headers **sort**: a click sorts low to high, a second high to low, a
third returns to the saved order. The sort applies to every section, is remembered in the browser
(local storage, a per-viewer convenience) and keeps rows without a price last. While a sort is on,
Move up and Move down are hidden, since they change the saved order. No schema change.

## Amendment (2026-11-17, N294, N295)

- **Side by side.** Sections fill a grid of as many columns as fit (each at least 30rem), so a wide
  screen shows two or three sections across; a phone shows one. Column widths shrink on a phone and
  the symbol badges hide there.
- **Default tab.** The sidebar's Quantitative Research link goes to `/research/open`, which reopens
  the Research tab last viewed when that was within 30 minutes and after the current sign-in began,
  and the Watch list otherwise. The Research tabs write the tab and time to a per-browser cookie
  (`tm_research_tab`), renewed each minute while one is open. Links straight to a tab are unchanged.
