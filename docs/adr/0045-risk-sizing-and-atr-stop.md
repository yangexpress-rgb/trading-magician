# ADR 0045: Risk-based sizing from ATR, and a fixed ATR stop

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §6.6, §6.9, §7.3, §13.2; design v1.2 item 9, row N42; builds on ADR 0027
  (position values in Exit rules) and the v1.2 time stop (N11)

## Context

Strategies could size by units, amount, % of equity or a fixed amount at risk to a stop price,
but not "risk 1% of equity with the stop 2 × ATR(20) away", and no Exit could use an ATR frozen
at entry. The v1.2 brief (item 9) asks for both, with every trade's sizing auditable by hand.

## Decision

- **Schema.** A Quantity type `risk_atr` (the brief's `riskBased`): `value` is the risk % of
  equity, with `atrPeriod` (1–500) and `atrMultiple`. An Exit rule `atrStop` {`atrPeriod`,
  `atrMultiple`} beside `timeStop`. Both optional, so older definitions parse and hash as before.
- **One shared implementation.** `packages/domain/src/strategy/risk-exits.ts` defines the ATR and
  close expressions (daily bars), the series to load, the stop level and the crossing test, and
  the limit cap; `sizeOrder` sizes `risk_atr`. Back tests and paper runs both call them.
- **Sizing.** quantity = floor((equity × risk% ÷ 100) ÷ (ATR × multiple)) in whole lots, with
  equity rounded to the cent and ATR to 4 decimals, as shown, so a hand check matches exactly.
  The quantity is lowered to the tightest of buying power, maximum order size and maximum
  exposure (`riskSizingCap`), and the trade records which. No ATR, or 0 shares, places nothing
  and says why (back-test warning, paper cycle `sizing[legId].skipped`).
- **ATR stop.** The ATR is captured when Entry is decided; the level (entry fill price ∓
  multiple × ATR) is fixed when the position opens and never moves. A daily close beyond it
  forces the Exit (`exitReason` `atr_stop`), at the next bar like the time stop. It watches the
  first Entry leg's instrument. Back tests read ATR and closes on the run's fill price basis, so
  the level and the closes share the entry price's basis.
- **Reporting.** Back-test trades store `sizing` and `atr_stop` (jsonb, migration 0059, which also
  allows `atr_stop` as an exit reason). The trade list shows a Sizing column with the working and
  the stop level under the exit; the trades CSV adds the same fields.

## Consequences

- Trailing stops are not built (design open point O28).
- A multi-instrument Entry gets one stop from its first leg (O29); the stop is checked on daily
  closes only (O30).
- Fixed-quantity strategies are unaffected.
