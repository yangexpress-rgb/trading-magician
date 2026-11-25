# ADR 0116: Local Companion pairing, its API and the "isn't connected" status

- **Status:** accepted
- **Date:** 2026-11-24
- **Design refs:** design v1.3 §17.4, §19; N335 to N337; O216. Yong's brief "Separate the research data
  from the trading core, with a built-in local setup flow" (2026-11-24), stage S2, step 1 of the S2
  plan (https://claude.ai/artifact/3Ufhu3mUFmdGjHhGaEgmQD). Yong said yes to starting S2 on 2026-11-24.

## Context

S2 moves the research jobs to a Local Companion on the user's own computer. The brief asks that the
companion pair with the app's existing agent-connection machinery under a dedicated research-sync
scope, revocable in Settings, and that the cloud never waits on a companion. This step builds the
pairing, the first companion API and the status research pages show. The companion itself, the
local Postgres and the Python jobs are later steps; nothing here changes where research runs.

## Decision

- **A scope, not a new credential system (N335).** `agent_scope` gains `research_sync`. A pairing is
  an ordinary agent connection (profile `local-companion`, no expiry) with the same hashed `tma_`
  token, revoking and audit. Settings › Local research storage pairs and unpairs; the AI agents
  page no longer lists pairings. The MCP endpoint refuses a `research_sync` token outright, and the
  companion API refuses every other scope, so neither can stand in for the other.
- **The companion API (N336).** `/api/companion/v1` authenticates with the pairing token, 120 calls a
  minute, and acts as the person who paired. `POST hello` records version, platform and when it was
  seen (`research_companion`, migration 0112). `GET instruments` (paged by id, demo instruments left
  out) and `GET membership` serve read-only reference data. Frozen Output pushes come with the
  trainer step.
- **The cloud never waits (N337).** `RESEARCH_MODE` (web) is `cloud` by default: research runs in
  the cloud as in S1 and nothing shows. In `companion` mode, research pages read when the producer's
  companion (the platform admin's, through `research_companion_seen_at`, one timestamp) last said
  hello. Not seen for 48 hours, or none paired, and they say: "Local research storage isn't
  connected — ML training and pattern mining are paused. Trading is unaffected." What was last
  delivered still shows; trading never reads any of it.

## Deviations from the brief

- **O216: one producer of shared research.** ML predictions and pattern scans are one shared set
  today, read by every member's `ml.score`, so the connected status follows the platform admin's
  companion. This is the S2 plan's recommendation on question 4, built ahead of Yong's answer
  and confirmed by Yong on 2026-11-25 ("go with your picks"); per-member companions would change only whose
  timestamp the status reads.

## Consequences

Pairing is safe to ship before any companion exists: with `RESEARCH_MODE` unset nothing changes for
anyone. A revoked pairing stops at once and the status turns to not connected at the next page load.
