# Trading Magician

A web app for planning, testing and running multi-asset trading strategies, built from the Trading App Design Document v1.0.

> **Paper trading only.** This build cannot submit real orders. Live trading is disabled in code (see `docs/adr/0002-paper-only-guard.md`).

## Status

Phase 0 (foundation) in progress. See `docs/traceability.md` for what is done.

| Milestone | Scope                                                          |
| --------- | -------------------------------------------------------------- |
| M0.1      | Monorepo, strict TypeScript, lint, tests, CI, env validation   |
| M0.2      | Database, migrations, row-level security, audit log, demo seed |
| M0.3      | Authentication and profile                                     |
| M0.4      | App shell and five-tab navigation                              |
| M1.1–M1.5 | Strategy Lab                                                   |

## Layout

```text
apps/web        Next.js UI and REST API
apps/worker     Background worker (health check only for now)
packages/config Environment validation helpers
packages/domain Pure domain logic shared by web, backtester and runtime
docs/adr        Architecture decision records
docs/traceability.md  Requirement-to-code matrix
```

## Getting started

Requirements: Node 22, pnpm 10 (`corepack enable`), Docker (for Postgres and Mailpit from M0.2).

```sh
pnpm install
pnpm dev          # web on http://localhost:3000, worker health on :4001/healthz
pnpm check        # format check, lint, typecheck, tests
pnpm build
```

Copy `.env.example` to `.env` and fill in values locally. Never commit `.env`.

## Rules for contributors

- Do not collapse a strategy to one symbol; every expression picks its own instrument.
- Money and quantities use decimal arithmetic, never floats.
- Store timestamps in UTC; a date/time without a timezone is invalid.
- No secrets in code, seed data, logs or browser storage.
- No live-trading code paths before Phase 7.
