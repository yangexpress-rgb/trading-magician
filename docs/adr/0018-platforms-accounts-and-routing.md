# ADR 0018: Trading platforms, accounts and routing per account

- **Status:** accepted
- **Date:** 2026-10-05
- **Design refs:** §6.7, §9.3, §9.4, §14.4, §15.4

## Context

Until now every order went to the built-in simulated broker through the one demo account. With
Alpaca (ADR 0017) a person can have several paper accounts on different platforms, pick a default,
and turn a platform or an account off. Each leg names its account, so a running strategy can
trade through more than one platform, and the validator has to know what each account can do.

## Decision

- **Platforms hold the key; accounts are discovered.** A platform (`broker_connection`) is a
  provider plus a stored paper key (ADR 0015). Adding one, pressing Test, or turning it back on
  queues a check, and the worker also checks active platforms every five minutes
  (`claim_broker_checks`). A check proves the key and lists the accounts it reaches; each is
  matched on the provider's own id (`trading_account.external_id`, unique per platform), so
  rediscovery refreshes capabilities and never duplicates. Only a masked number is shown. A
  platform that stops answering raises a disconnect notification.
- **Routing per account.** Each runtime pass builds one broker adapter over every account its
  strategy uses. The demo account goes to the simulated broker; others go to their platform's
  adapter, opened with the platform's key, once per pass. An account whose platform is off, has
  no adapter, or whose key cannot be opened reads as an unreachable broker, so the existing
  broker-down pause (ADR 0014) applies.
- **Capabilities decide validation.** Accounts carry their order types, time in force, sides,
  extended hours, short selling and **coverage**: `demo` (only the demo instruments) or `us`
  (real US listings). A leg that sends a demo instrument to a US account, or the reverse, is a
  `unsupported_venue` error. The demo account's capabilities now say what the simulator really
  does: no extended-hours session (it already refused such orders at submit time).
- **The default account and moving strategies.** One account per tenant is the default and new
  strategies use it. Making another the default can also move existing strategies from the old
  default; strategies that are running are left alone and counted, because their rules are
  pinned to a version.
- **Turning off with consent (§9.4).** Turning off a platform or an account that a running or
  paused strategy trades through is refused with the list of those strategies; confirming pauses
  them first, with a reason naming what was turned off. An account on a platform that is off is
  treated as off for validation.
- **Removing.** The demo platform cannot be removed. A platform cannot be removed while
  strategies use its accounts or one of them is the default, nor once its accounts have order
  history, which is kept; turning it off is the alternative.

## Consequences

- A real paper order can now be placed and canceled end to end with an Alpaca paper key entered
  in Settings; that manual check confirms the fake's reading of Alpaca's API.
- Strategies that set extended hours on the demo account now fail validation instead of failing
  at submit time.
- Per-account risk limits and safety settings stay global constants for now (ADR 0014).
