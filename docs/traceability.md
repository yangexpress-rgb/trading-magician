# Traceability matrix

Maps requirements in the Trading App Design Document v1.0 to their implementation and tests. Updated with every milestone.

**Status key:** Done · Partial · Planned (milestone) · Deferred (phase)

## Phase 0: repository and foundation (§18)

| Requirement                                      | Design ref    | Status                                      | Where                                                              | Tests                                      |
| ------------------------------------------------ | ------------- | ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| Monorepo with separate web and worker packages   | §18 P0, §12.1 | Done (M0.1)                                 | `apps/web`, `apps/worker`, `packages/*`                            | CI build                                   |
| TypeScript strict mode                           | §18 P0        | Done (M0.1)                                 | `tsconfig.base.json`                                               | `pnpm typecheck`                           |
| Linting and formatting                           | §18 P0        | Done (M0.1)                                 | `eslint.config.mjs`, `.prettierrc.json`                            | `pnpm lint`, `pnpm format:check`           |
| Automated tests and CI                           | §18 P0, §17.4 | Done (M0.1)                                 | `.github/workflows/ci.yml`                                         | all                                        |
| Environment configuration with schema validation | §18 P0        | Done (M0.1)                                 | `packages/config/src/env.ts`                                       | `env.test.ts`                              |
| No secrets in `.env` examples beyond blank names | §21           | Done (M0.1)                                 | `.env.example`                                                     | review                                     |
| Secrets never written to logs                    | §9.2, §16.1   | Partial (M0.1: worker logger redaction)     | `apps/worker/src/logger.ts`                                        | `worker.test.ts`                           |
| Live trading disabled                            | §18, §21      | Done (M0.1 code guard, M0.2 DB constraints) | `packages/domain/src/trading-mode.ts`, `packages/db/src/schema.ts` | `trading-mode.test.ts`, `security.test.ts` |
| Worker separate from web runtime                 | §12.1         | Partial (M0.1: health-only skeleton)        | `apps/worker`                                                      | `worker.test.ts`                           |
| Dependency scanning                              | §16.1         | Done (M0.1)                                 | `pnpm audit` job, Dependabot                                       | CI                                         |
| Basic security headers                           | §16.1         | Done (M0.1, nonce CSP in M0.4)              | `apps/web/next.config.ts`, `apps/web/proxy.ts`                     | `csp.test.ts`                              |
| PostgreSQL migrations, generic demo seed         | §18 P0, §21   | Done (M0.2)                                 | `packages/db/migrations`, `packages/db/src/demo.ts`                | CI `integration`, `e2e`                    |
| Tenant isolation in app and database             | §4.1, §19.1   | Done (M0.2)                                 | `0001_security.sql`, `packages/db/src/tenant.ts`                   | `security.test.ts`                         |
| Append-only audit events                         | §16.2         | Done (M0.2)                                 | `audit_event` grants and trigger, `audit.ts`                       | `security.test.ts`                         |
| Authentication flows                             | §4.2          | Done (M0.3)                                 | `apps/web/lib/server/auth.ts`, `app/(auth)`                        | `e2e/auth.spec.ts`                         |
| Profile: timezone, base currency                 | §9.1          | Done (M0.3)                                 | `app/(app)/settings/profile`                                       | `profile.test.ts`, `e2e/shell.spec.ts`     |
| Design system and five-tab navigation            | §5, §18 P0    | Done (M0.4)                                 | `packages/ui`, `apps/web/components/app-shell.tsx`                 | `e2e/shell.spec.ts` (axe)                  |

## Phase 1: validated Strategy Lab (§18)

| Requirement                                                     | Design ref        | Status                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy schema v1 and expression tree                          | §6.4, §13.2       | Done (M1.1): `strategy/schema.ts`, `tree.ts`, `catalog.ts`; tests `schema.test.ts`, `tree.test.ts` (property-based)                                                                                                                                                                                                                          |
| Timing rules                                                    | §6.8              | Done (M1.1): `strategy/timing.ts`; `timing.test.ts` (property-based cycle detection)                                                                                                                                                                                                                                                         |
| Validation before save/activation                               | §6.10             | Done (M1.1): `strategy/validate.ts`; `validate.test.ts`                                                                                                                                                                                                                                                                                      |
| Lifecycle state machine                                         | §6.3              | Done (M1.1): `strategy/lifecycle.ts`; `lifecycle.test.ts`                                                                                                                                                                                                                                                                                    |
| Condition evaluation (shared by preview, back test, runtime)    | §6.5              | Done (M1.1): `strategy/evaluate.ts`; `evaluate.test.ts`                                                                                                                                                                                                                                                                                      |
| Strategy API and library                                        | §6.1, §14.1       | Done (M1.2): `apps/web/app/api/v1/strategies`, `packages/db/src/strategies.ts`, `packages/contracts`, library at `/strategy-lab`; tests `db/test/strategies.test.ts` (incl. cross-tenant), `e2e/strategies.spec.ts`, ADR 0006                                                                                                                |
| Immutable versions                                              | §6.2              | Done (M1.2): `strategy_version` grants and trigger (`0005_strategy_security.sql`); `strategies.test.ts`                                                                                                                                                                                                                                      |
| Condition builder UI                                            | §6.4, §15.1, §5.1 | Done (M1.3): `components/strategy/condition-editor.tsx`, `expression-editor.tsx`, `strategy-lab/[id]/strategy-editor.tsx`; tests `e2e/editor.spec.ts` (SMA(30, DEMO-A) < SMA(30, DEMO-B) round trip, nested AND/OR/NOT, conflicts, unsaved-changes warning), `strategy-text.test.ts`                                                         |
| Planned orders and timing UI                                    | §6.6–6.9, §15.1   | Done (M1.4): `components/strategy/orders-editor.tsx`, `timing-editor.tsx`, `settings-editor.tsx`; zoned time helpers in `packages/domain/src/time.ts`; tests `e2e/orders.spec.ts` (long DEMO-A + short DEMO-B, exit 5 min after entry submitted; exact zoned time, limit price, sequential legs, risk), `time.test.ts` (DST gap and overlap) |
| Validation and lifecycle UI                                     | §6.10, §15.1      | Done (M1.5): `components/strategy/lifecycle.tsx` (`ValidationPanel`, live server re-check after every save, issue locations in editor words, header summary); `e2e/lifecycle.spec.ts`                                                                                                                                                        |
| Created, Under testing, Actively executing, Off states          | §6.3, §18 P1      | Done (M1.5): status controls in the Back Test panel; paper start pins a version and records acknowledged warnings; stop leaves orders and positions alone (§8.1); `e2e/lifecycle.spec.ts`, `strategies.test.ts`                                                                                                                              |
| Start/Stop placed right after Run back test; paper confirmation | §5.2, §7.4, §15.1 | Done (M1.5): `BackTestPanel` with inputs shown and Run disabled until Phase 2; confirmation summarises strategy, mode, accounts, instruments, legs and exposure, and requires each warning to be acknowledged; order of controls asserted in `e2e/lifecycle.spec.ts`                                                                         |
| Version history view                                            | §6.2              | Done (M1.5): `strategy-lab/[id]/versions/[versionNo]`, `components/strategy/version-summary.tsx`; draft match and start history per version; `e2e/lifecycle.spec.ts`                                                                                                                                                                         |

With M1.5, every §18 Phase 0 and Phase 1 item above is Done. The two Partial rows in Phase 0 come from §9.2, §12.1 and §16.1 rather than the §18 list, and are finished as the worker and credential storage arrive in later phases.

## Phase 2: back testing (§18)

| Requirement                                 | Design ref         | Status                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Historical-data adapter contract            | §7.1, §18 P2       | Done (M2.1): `HistoricalDataProvider`, `BarSeries` in `packages/domain/src/market/bars.ts`; ADR 0007                                                                                                                                 |
| Generic demo price history                  | §21, §20 #1        | Done (M2.1): `packages/market-data` (factor model, split, dividends, missing hourly bars); `demo-history.test.ts`                                                                                                                    |
| NYSE trading calendar                       | §6.7, §20 #10      | Done (M2.1): `packages/domain/src/market/calendar.ts`; `calendar.test.ts`                                                                                                                                                            |
| Indicator calculations, no lookahead        | §6.4, §7.2         | Done (M2.1): `packages/domain/src/market/indicators.ts`; `indicators.test.ts` (property-based)                                                                                                                                       |
| Shared rule engine, alignment, fills, costs | §7.2               | Done (M2.2): `packages/backtest` (`simulate`, fill model, metrics); ADR 0008; `properties.test.ts` (no lookahead)                                                                                                                    |
| Durable jobs and run status; provenance     | §7.2, §13.3, §14.2 | Done (M2.3): `backtest_run`/`backtest_trade` + `claim_backtest_run` (0006–0007); `packages/db/src/backtests.ts`; `apps/worker/src/backtests.ts`; §14.2 routes; ADR 0009; `backtests.test.ts`, `backtests-api.spec.ts`                |
| Results, trade list, charts, assumptions    | §7.3               | Done (M2.4): `apps/web/components/strategy/backtest.tsx` (inputs, live status, history, tiles, SVG charts, trades, contribution, warnings, assumptions aside, CSV); `backtest.spec.ts` with axe                                      |
| Start placement and activation gate         | §7.4               | Done (M2.5): `validateStoredStrategy` feeds the latest completed run to `no_backtest`/`stale_backtest`; panel and Start dialog show latest run and draft match; start audit records the run; `backtest.spec.ts`, `backtests.test.ts` |

## Phase 3: paper execution (§18)

| Requirement                                      | Design ref              | Status                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical order model and states                 | §8.4, §13.4, §17.4      | Done (M3.1): `packages/domain/src/execution/order-state.ts` (`transitionOrder`, `deriveBrokerOrder`); ADR 0010; `order-state.test.ts` (property-based: arrival order, duplicates, terminal states)                                                                    |
| Immutable order intents with idempotency keys    | §8.2, §8.5              | Done (M3.1): `order_intent` append-only (0008–0009); `packages/db/src/orders.ts` (`recordOrderIntent`, `idempotencyKey`); `orders.test.ts`                                                                                                                            |
| Broker updates replayable and out-of-order safe  | §8.5                    | Done (M3.1): `applyBrokerUpdates` stores each update once and re-derives state; `order_event` timeline, `fill`; `orders.test.ts`                                                                                                                                      |
| Sizing and pre-trade risk shared with back test  | §6.6, §8.6              | Done (M3.1): `sizeOrder`, `checkPreTradeRisk` in `@tm/domain`, used by `simulate`; `sizing.test.ts`, `risk.test.ts`, back-test suite unchanged                                                                                                                        |
| Runtime, cycle, trigger and schedule records     | §13.3                   | Done (M3.1, M3.3): tables, tenant isolation and lease claims (0008–0011); `packages/db/src/runtime.ts`; `runtime.test.ts`                                                                                                                                             |
| One paper-broker adapter first                   | §18 P3, §9.3            | Done (M3.2): `BrokerAdapter` contract in `@tm/domain`; `packages/broker` (`PaperBroker`, `withFaults`, `describeBrokerContract`); ADR 0011; `paper-broker.test.ts` (contract suite plain and with injected faults)                                                    |
| Live prices with provider and receipt timestamps | §6.5, §17.1, §20 #1     | Done (M3.2): `LiveQuoteProvider`; `createDemoLiveFeed` follows NYSE hours and agrees with the hourly bars; `demo-live.test.ts`                                                                                                                                        |
| Runtime orchestration and timing scheduler       | §6.5, §6.8, §8.1, §12.4 | Done (M3.3): `apps/worker/src/runtime.ts` (`runRuntimePass`, `startRuntimeLoop`), durable `scheduled_action`; ADR 0012; `runtime.test.ts` (restart, other worker fires the schedule, no duplicates, stop, kill switch)                                                |
| Entry-first/Exit-second lifecycle                | §6.9, §19.6             | Done (M3.3): `planCycle` in `packages/domain/src/execution/cycle.ts` shares trigger, sizing and risk with the back test; `cycle.test.ts`, `runtime.test.ts`                                                                                                           |
| Orders tab with live updates                     | §8.3, §14.3, §15.2      | Done (M3.4): `/api/v1/orders`, `/positions`, `/execution` routes; `packages/db/src/order-views.ts`; SSE via `pg_notify` (0012); `components/orders/`; ADR 0013; `order-views.test.ts`, `e2e/paper-orders.spec.ts`. Saved views are bookmarkable filters for now       |
| Stop and kill switch options                     | §8.1, §5.2              | Done (M3.4): stop offers cancel working orders and close positions separately; kill switch with separately confirmed cancel-all; `runtime.test.ts`, `order-views.test.ts`                                                                                             |
| Reconciliation, risk pause, audit, notifications | §8.5, §8.6, §16.2–16.3  | Done (M3.5): `packages/db/src/reconcile.ts`, `incidents.ts`, `notifications.ts` (0013–0014); worker safety checks in `apps/worker/src/runtime.ts`; Orders banner and `/notifications`; ADR 0014; `runtime.test.ts`, `order-views.test.ts`, `e2e/paper-orders.spec.ts` |

### §19.6 acceptance criteria

| Criterion                                                                        | Status                                                                                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Start execution sits after Run back test and needs mode-appropriate confirmation | Done (M2.5, M3.4): Back Test panel and Start dialog; `lifecycle.spec.ts`, `paper-orders.spec.ts`                     |
| Active paper strategies consume feed events automatically                        | Done (M3.3): runtime loop reads the live feed each pass; `runtime.test.ts`, `paper-orders.spec.ts`                   |
| Entry orders become intents only after Entry qualifies                           | Done (M3.3): `planCycle`; `cycle.test.ts`, `runtime.test.ts` (trigger events recorded once per bar)                  |
| Exit evaluation and orders follow the configured Entry milestone                 | Done (M3.3): `cycle.test.ts`, `runtime.test.ts` (Exit five minutes after Entry from a durable schedule)              |
| Orders show strategy, version, cycle, phase, trigger and broker timeline         | Done (M3.4): order table and drawer; `order-views.test.ts`, `paper-orders.spec.ts`                                   |
| Stop prevents new orders without silently canceling or liquidating               | Done (M3.4): `runtime.test.ts` (stops without canceling; cancels and closes only when asked), `paper-orders.spec.ts` |

## Phase 4: settings and integrations (§18)

| Requirement                                   | Design ref         | Status                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure credential capture, never returned     | §9.2, §9.3, §16.1  | Done (M4.1): `packages/db/src/sealed.ts`, `credentials.ts`, `credential` table and `tm_secrets` grants (0015–0016); `/api/v1/credentials`; Stored API keys panel; ADR 0015; `credentials.test.ts`, `e2e/credentials.spec.ts`                                                                                    |
| Feed list, routes, health and connection flow | §9.2, §9.4, §14.4  | Done (M4.2): `packages/domain/src/integrations/routing.ts`, `packages/db/src/feeds.ts`, migrations 0017–0018, worker `feed-checks.ts` and `routed-quotes.ts`; `/api/v1/data-feeds`, `/api/v1/data-routes`; Settings › Data feeds; ADR 0016; `routing.test.ts`, worker `feeds.test.ts`, `e2e/data-feeds.spec.ts` |
| First real provider and capability discovery  | §9.3, §20 #1–2     | Planned (M4.3)                                                                                                                                                                                                                                                                                                  |
| Broker platform and multi-account management  | §9.3, §9.4, §14.4  | Planned (M4.4)                                                                                                                                                                                                                                                                                                  |
| User profile and notifications                | §9.1, §15.4, §16.3 | Planned (M4.5)                                                                                                                                                                                                                                                                                                  |

## Product decisions confirmed (2026-10-04)

| §20 item                    | Decision                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Auth approach               | Self-hosted Better Auth in the app's Postgres                                                                           |
| Phase 1 instrument coverage | US stocks and ETFs (schema supports more)                                                                               |
| #11 Paper risk defaults     | $10,000 max order; $25,000 max strategy exposure; 10 active orders; $1,000 daily loss; 5% price collar; 60 s stale data |
| #7, #8 Multi-leg default    | Concurrent submission; 60 s leg timeout, then cancel remaining legs and flag imbalance                                  |
| #10 Market closed           | Queue to next regular session; NYSE holiday calendar                                                                    |
| §20 closing defaults        | Paper only; one open cycle; on-transition triggers; full Entry fill before Exit                                         |

## Phase 2 defaults confirmed (2026-10-04)

Each is an editable input or a single constant.

| §20 item                   | Decision                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| #1 Price history source    | Generated demo history for the DEMO instruments, behind `HistoricalDataProvider`                                                       |
| #5 Resolution and range    | Daily by default, hourly optional; at most 5 years daily or 1 year hourly per run                                                      |
| #6 Fill and cost defaults  | Market at next open; limits and stops when traded through; 5 bps slippage; no commission; 10% of bar volume per fill; 1% a year borrow |
| #12 Back test before start | Not required on paper; a missing or out-of-date back test is a warning to acknowledge                                                  |

## Phase 3 defaults confirmed (2026-10-04)

| §20 item                | Decision                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| #2 Paper broker         | Built-in simulated paper broker behind `BrokerAdapter`; a real broker's paper account in Phase 4                 |
| #1 Live prices on paper | Simulated live feed for the DEMO instruments following NYSE hours and holidays; tests drive the clock            |
| #8 Partial fills        | Exit waits for full Entry fill; after the 60 s timeout the filled part stays open and Exit sizes to what is held |
| #9 Re-entry             | One open cycle per strategy, no pyramiding; a new cycle may start after the previous one exits                   |
| #13 Notifications       | In-app only for now                                                                                              |
| §8.6 Safety pauses      | 3 rejects in a row; prices stale for 60 s past the threshold; broker silent for 60 s; reconcile every 60 s       |

## Phase 4 defaults confirmed (2026-10-04)

| §20 item                   | Decision                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| #1, #2 First real provider | Alpaca: IEX prices and a paper broker on one key; demo feed and simulated broker stay built in             |
| Credential storage         | Sealed in the app's Postgres; private key only in the worker's environment, a cloud key service in Phase 6 |
| Connection method          | Paste a paper API key into a write-only form; OAuth later                                                  |
| #13 Notifications          | In-app only; each kind can be muted except risk pauses, reconciliation mismatches and disconnects          |
| Feed failover              | Switch back to the primary after it has been healthy for 5 minutes; both switches audited and notified     |
