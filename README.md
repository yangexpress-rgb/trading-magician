# Trading Magician

A web app for planning, testing and running multi-asset trading strategies, built from the Trading App Design Document v1.0.

> **Paper trading only.** This build cannot submit real orders. Live trading is disabled in code (see `docs/adr/0002-paper-only-guard.md`).

## Status

Phase 0 (foundation) complete: M0.1–M0.4. Phase 1 (Strategy Lab) next. See `docs/traceability.md` for what is done.

| Milestone | Scope                                                                   |
| --------- | ----------------------------------------------------------------------- |
| M0.1      | Monorepo, strict TypeScript, lint, tests, CI, env validation            |
| M0.2      | Database, migrations, row-level security, audit log, demo seed          |
| M0.3      | Authentication and profile                                              |
| M0.4      | App shell and five-tab navigation                                       |
| M1.1–M1.5 | Strategy Lab                                                            |
| M2.1–M2.5 | Back testing: data, engine, durable runs, API, results, activation gate |

## Layout

```text
apps/web        Next.js UI and REST API
apps/worker     Background worker: runs queued back tests and paper strategies (needs DATABASE_APP_URL)
packages/config Environment validation helpers
packages/domain Pure domain logic shared by web, backtester and runtime
packages/market-data Demo market data: generated history and a simulated live feed
packages/backtest    The back-test engine (pure simulation, fill model, metrics)
packages/broker      Broker adapter contract suite and the simulated paper broker
packages/db     Drizzle schema, migrations, row-level security, tenant scoping
packages/ui     Design tokens and accessible UI primitives (Tailwind CSS)
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

To deploy, see `docs/deploy.md` (Railway).

### Database

```sh
docker compose up -d postgres
export DATABASE_URL=postgres://tm_owner:tm_owner_local@localhost:5432/trading_magician
pnpm --filter @tm/db db:migrate
pnpm --filter @tm/db db:seed
DB_APP_LOGIN_PASSWORD=... DB_AUTH_LOGIN_PASSWORD=... DB_WORKER_LOGIN_PASSWORD=... pnpm --filter @tm/db db:setup-logins

# Integration tests create and drop their own database:
TEST_DATABASE_URL=postgres://tm_owner:tm_owner_local@localhost:5432/postgres pnpm test:integration
```

The app never connects as the owner at runtime. See `docs/adr/0003-tenant-isolation.md`.

### Running the web app

```sh
export DATABASE_APP_URL=postgres://tm_app_login:<password>@localhost:5432/trading_magician
export DATABASE_AUTH_URL=postgres://tm_auth_login:<password>@localhost:5432/trading_magician
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# Provider API keys are sealed with a key pair (docs/adr/0015-credential-storage.md).
# Put CREDENTIALS_PUBLIC_KEY in the web app's env and CREDENTIALS_PRIVATE_KEY in the worker's only:
pnpm --filter @tm/db credentials:keygen
docker compose up -d mailpit   # verification and reset emails appear at http://localhost:8025
pnpm --filter @tm/web dev
```

The worker connects with its own login, which may also read sealed credentials:
`DATABASE_WORKER_URL=postgres://tm_worker_login:<password>@localhost:5432/trading_magician`.

### End-to-end tests

The tests run on invented demo instruments and a demo feed, which exist only with
`DEMO_DATA=on` (docs/adr/0039-no-demo-data-in-deployments.md). With the database migrated,
seeded with `DEMO_DATA=on pnpm --filter @tm/db db:seed`, logins created, and the env above set:

```sh
pnpm --filter @tm/web build
pnpm --filter @tm/web exec playwright install chromium   # or set PW_CHROMIUM_PATH
pnpm --filter @tm/web test:e2e
```

Tests use `MAIL_TRANSPORT=outbox` and read emails from `apps/web/.mail-outbox/`.

## Rules for contributors

- Do not collapse a strategy to one symbol; every expression picks its own instrument.
- Money and quantities use decimal arithmetic, never floats.
- Store timestamps in UTC; a date/time without a timezone is invalid.
- No secrets in code, seed data, logs or browser storage.
- No live-trading code paths before Phase 7.
