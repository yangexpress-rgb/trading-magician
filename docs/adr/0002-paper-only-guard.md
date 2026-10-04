# ADR 0002: Paper-only guard

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §18, §21 engineering rules, §22

## Context

Live trading must not be reachable until Phase 7, after paper acceptance, legal review and a controlled rollout.

## Decision

`@tm/domain` exports `LIVE_TRADING_ENABLED = false` as a compile-time constant and `assertAllowedTradingMode()`, which rejects `live`. Every component that accepts a trading mode (accounts, broker adapters, activation) must call it. From M0.2 the database also restricts `mode` columns to `paper` with CHECK constraints, so the guard holds even if application code is wrong.

Turning live trading on is a deliberate, reviewed code change to this constant and the constraints, not configuration.

## Consequences

There is no environment variable that can enable live trading in Phases 0–6.
