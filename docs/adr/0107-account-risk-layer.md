# ADR 0107: Account limits, the account daily-loss halt and the account kill switch

- **Status:** accepted
- **Date:** 2026-11-22
- **Design refs:** design v1.3 §12.3, §12.4, §8.1 (kill switch), §16.3; N311, N312, N313; O181 to
  O184. Phase 7 brief §5 ("Risk limits per account (this closes D4)"), build P1, started at Yong's
  OK on 2026-11-22. Builds on ADR 0106 (a run is one strategy on one account). Closes the
  account-level part of v1.1 deviation D4; per-symbol and per-asset-class limits stay open.

## Context

Until now every risk limit belonged to a strategy and was judged on that run's own book: maximum
order size, strategy exposure, daily loss, drawdown, instruments held and the price collar.
Several strategies on one account could together hold far more than any one of them was allowed,
and nothing stopped one account's day of losses from going on. The only kill switch was global:
it paused every run on every account.

Since ADR 0106 every run trades on exactly one account, and every order, fill, position and
valuation carries its account. An account is also its own netting universe at the broker (ADR
0105). So the account is where limits that span strategies belong.

## Decision

- **Account limits are optional and live on the account** (`trading_account.max_exposure`,
  `daily_loss_limit`, migration 0104; both dollars, above zero, or null for none). They are set
  in Settings › Accounts with **Set limits**. Existing accounts get none, so nothing trades
  differently until a person sets one (A8). Per-strategy limits are unchanged and still apply.
- **N311: maximum total exposure per account.** A new pre-trade check, `risk_account_exposure`
  ("Account exposure"), runs after the strategy's own exposure check for orders that open or add
  risk. It adds the order's notional to the gross value of everything the app holds on the
  account across every run (net quantity per instrument from the app's fills, at the pass's
  quotes, or the last fill price when there is no quote), plus the unfilled part of every working
  Entry order on the account, plus openings recorded earlier in the same pass. Closing orders skip
  it. Like strategy exposure it is a capacity refusal (N300): it clears as positions close and
  does not count toward the rejections-in-a-row pause.
- **N312: the account daily loss limit halts that account for the day (A3).** The account's
  valuation (every 5 minutes, ADR 0020) now also judges its loss for the New York trading day:
  the app's P&L on the account now, less where it stood at the latest earlier session's valuation.
  When the loss reaches the limit, the account is halted for the rest of that day
  (`halt_kind = 'daily_loss'`, `halt_date`): every running run on it pauses with the reason in
  words, positions stay open and working orders are not canceled, an **Account daily loss**
  incident is opened on the account (`account_daily_loss`) and a notification goes out. Runs on
  other accounts are untouched. A valuation with a holding at a stale or missing price does not
  judge the loss. The halt ends with the day by itself; paused runs then stay paused until each is
  resumed.
- **N313: the account kill switch (A4).** **Kill switch** on an account in Settings › Accounts,
  after a confirmation that says what it does, pauses every running run on that account
  ("Kill switch engaged on …") and asks the broker to cancel every working order on it. Positions
  stay. Other accounts keep trading. The account stays halted (`halt_kind = 'kill_switch'`) until
  **Release halt**, which ends any halt on the account (a daily-loss one too), resolves its open
  daily-loss incident and resumes nothing. The global kill switch (§8.1) is unchanged.
- **A halted account starts and resumes nothing.** Start (or Start on another account), Resume,
  and the automatic resumes (N283, N301) are refused on a halted account, with the reason in words
  ("The kill switch is engaged on Demo paper account. Release it in Settings › Accounts first";
  "… reached its daily loss limit and is halted for the rest of today").
- Each change is audited: `trading_account.limits_changed`, `trading_account.kill_switch_engaged`,
  `trading_account.daily_loss_halt`, `trading_account.halt_released`.

## Consequences

- Paper and future live accounts share the same layer; P3's pilot caps can be added as tighter
  account limits.
- The daily loss is judged at most 5 minutes late, since it rides on the account valuation
  (O181). The exposure check is judged before every order.
- Exposure counts only what the app traded on the account; holdings bought outside the app are
  not counted (O183), as with reconciliation's broker-side figures being informational.

## Open points

- **O181:** daily loss is judged on each account valuation (every 5 minutes), not on every pass.
- **O182:** the kill switch pauses runs rather than stopping them, so they keep their place and can
  be resumed after release.
- **O183:** account exposure counts the app's own fills on the account, not positions the broker
  holds from outside the app.
- **O184:** the daily-loss halt ends with the New York day by itself, but runs stay paused until a
  person resumes them.
