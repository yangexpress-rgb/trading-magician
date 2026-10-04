# ADR 0001: Monorepo and toolchain

- **Status:** accepted
- **Date:** 2026-10-04
- **Design refs:** §12.1, §12.3, §18 Phase 0

## Context

The design calls for a TypeScript-first modular monolith with the web runtime and long-running workers deployed separately, while backtest and live execution share rule semantics.

## Decision

- pnpm workspaces + Turborepo. `apps/web` (Next.js) and `apps/worker` (Node) are separate deployables; shared code lives in `packages/*`.
- `packages/domain` is pure TypeScript with no I/O, so the Strategy Lab, the Phase 2 backtester and the Phase 3 runtime use identical rule code.
- Internal packages export TypeScript source; the web app transpiles them (`transpilePackages`) and the worker runs through `tsx`. No per-package build step until one is needed.
- TypeScript `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- ESLint (flat config, typescript-eslint strict, Next.js rules) and Prettier; Vitest for tests.
- Environment variables are validated with zod at boot; validation errors name variables but never print their values.

## Consequences

Adding a deployable (for example a separate backtest worker) is a new `apps/*` entry that reuses `domain`. Package boundaries are enforced by workspace dependencies; a package can only import what it declares.
