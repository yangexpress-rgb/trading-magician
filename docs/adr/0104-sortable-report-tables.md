# ADR 0104: Every report table sorts by its column headers

- **Status:** accepted
- **Date:** 2026-11-18
- **Design refs:** design v1.3 §4 (Lists sort by any column); N303. Extends N167, N168 and N293.
  Requested by Yong on 2026-11-18: "in the list reports of this app, can we make the list
  sortable by each column label?", with Performance's Contribution by strategy and Contribution
  by asset as examples.

## Context

Only the Strategy Lab and Theory Library (sorted by URL on the server, N167, N168), the watch list
(N293) and the stock screener sorted by column. The other report tables (Performance, Orders, back
test results, research panels, admin and settings lists, about 40 in all) kept a fixed order.
Giving each one its own sort keys would have meant 40 separate changes, most of them in tables
whose cells are already formatted text.

## Decision

- **One shared table.** `Table` in `@tm/ui` (`packages/ui/src/sortable-table.tsx`) is a client
  component. Each `Th` with a visible label becomes a sort button; headers that hold only
  screen-reader text (actions columns), headers given `sort` (a list that sorts itself) and
  headers given `sortable={false}` (a select-all tick box) stay as they are.
- **Clicks.** The first click sorts low to high, the next high to low, the third returns to the
  list's own order, as in the watch list. ▲/▼ marks the sorted column (↕ faint on the others) and
  the header carries `aria-sort`. The choice is remembered in the browser for each table label
  (`localStorage` `tm.tableSort.<label>`); a remembered column the table no longer has is dropped.
- **Values.** A cell sorts by its `data-sort-value` (`Td sortValue`) if given, else a `<time
datetime>` inside it, else its text (`packages/ui/src/table-sort.ts`): a column whose filled
  cells all start with a number sorts as numbers (signs, true minus, $, commas, %, K/M/B/T,
  brackets), else as dates when every cell is a date as the app prints them, else as text in
  natural order ("S00027" before "S00100"), ignoring case. Blank cells (empty, dashes, n/a) go
  last both ways. Ties keep their current order.
- **In the page.** Rows are reordered in the browser inside their own `<tbody>`, so React's later
  updates (live figures, refreshes) still find every row; a watcher sorts again after each change.
  A table that only shows one page of rows (the audit log) sorts that page.
- **Not sorted.** Tables that read top to bottom pass `Table sortable={false}`: a company's annual
  financials (grouped statement lines) and Settings › Billing › Plans compared. The Strategy Lab
  and Theory Library keep their server sort (N167, N168); the watch list and screener keep their
  own. The back test cycle list is an ARIA grid, not a table, and is unchanged.

## Consequences

- New tables built from `Table` sort without extra work; a column whose text sorts wrongly gets
  `sortValue` on its cells.
- Sorting is per browser, not saved with the account.

## Amendment 2026-11-19: column filters (N304)

Requested by Yong on 2026-11-19 for Orders › Strategies on paper: "a list view for strategies under
execution … the column labels can be used to sort and filter".

- `Th` takes an optional `filter` control, drawn under the label on the column's edge (headers
  with filters align to the bottom), so a list with many columns stays as narrow as its labels.
- `HeaderFilter` (`apps/web/components/filters/header-filter.tsx`) is a funnel button that opens
  a small panel over the page (fixed to the window, so a table that scrolls sideways doesn't cut it
  off): typed text, a choice list or an at least / at most pair, reusing the filter pills' choice
  and range parts (N195). Choices apply at once; Esc or a click outside closes it; the funnel fills
  while its filter is set.
- The first user is Strategies on paper (`apps/web/components/orders/runtime-list.tsx`, rules in
  `apps/web/lib/runtime-list.ts`). Filtering happens in the page; sorting still works on the rows
  that remain. Filters are not remembered; the List / Cards choice is (`tm.orders.runtimeView`).

## Amendment 2026-11-19: figures list what they count (N305)

Yong, 2026-11-19: "when i double click the number of completed cycles, all orders counted needs to
be reported with detailed list. same behavior should be enabled for each number double clicked."

- Each figure in the Strategies on paper list is a focusable control: a double-click (or Enter)
  opens `RunDetailDialog` (`apps/web/components/orders/run-detail.tsx`) over the page.
- `GET /api/v1/execution/runtimes/{runtimeId}/detail?kind=working|completed|active|rejected|entering`
  (`getRunDetail` in `packages/db/src/order-views.ts`) returns the run's cycles of that outcome
  (newest 300) and all their orders; `working` returns only working orders. Realized P/L and Win
  rate open the completed cycles.
- The dialog's table is a flat, sortable `Table`: cycle columns repeat on each order row so sorting
  never splits a cycle's facts from its orders.
