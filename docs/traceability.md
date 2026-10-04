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

| Requirement                                                  | Design ref        | Status                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy schema v1 and expression tree                       | §6.4, §13.2       | Done (M1.1): `strategy/schema.ts`, `tree.ts`, `catalog.ts`; tests `schema.test.ts`, `tree.test.ts` (property-based)                                                                                                           |
| Timing rules                                                 | §6.8              | Done (M1.1): `strategy/timing.ts`; `timing.test.ts` (property-based cycle detection)                                                                                                                                          |
| Validation before save/activation                            | §6.10             | Done (M1.1): `strategy/validate.ts`; `validate.test.ts`                                                                                                                                                                       |
| Lifecycle state machine                                      | §6.3              | Done (M1.1): `strategy/lifecycle.ts`; `lifecycle.test.ts`                                                                                                                                                                     |
| Condition evaluation (shared by preview, back test, runtime) | §6.5              | Done (M1.1): `strategy/evaluate.ts`; `evaluate.test.ts`                                                                                                                                                                       |
| Strategy API and library                                     | §6.1, §14.1       | Done (M1.2): `apps/web/app/api/v1/strategies`, `packages/db/src/strategies.ts`, `packages/contracts`, library at `/strategy-lab`; tests `db/test/strategies.test.ts` (incl. cross-tenant), `e2e/strategies.spec.ts`, ADR 0006 |
| Immutable versions                                           | §6.2              | Done (M1.2): `strategy_version` grants and trigger (`0005_strategy_security.sql`); `strategies.test.ts`                                                                                                                       |
| Condition builder UI                                         | §6.4, §15.1       | Planned (M1.3)                                                                                                                                                                                                                |
| Planned orders and timing UI                                 | §6.6–6.8          | Planned (M1.4)                                                                                                                                                                                                                |
| Validation and lifecycle UI                                  | §6.10, §5.2, §7.4 | Planned (M1.5)                                                                                                                                                                                                                |

## Product decisions confirmed (2026-10-04)

| §20 item                    | Decision                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Auth approach               | Self-hosted Better Auth in the app's Postgres                                                                           |
| Phase 1 instrument coverage | US stocks and ETFs (schema supports more)                                                                               |
| #11 Paper risk defaults     | $10,000 max order; $25,000 max strategy exposure; 10 active orders; $1,000 daily loss; 5% price collar; 60 s stale data |
| #7, #8 Multi-leg default    | Concurrent submission; 60 s leg timeout, then cancel remaining legs and flag imbalance                                  |
| #10 Market closed           | Queue to next regular session; NYSE holiday calendar                                                                    |
| §20 closing defaults        | Paper only; one open cycle; on-transition triggers; full Entry fill before Exit                                         |
