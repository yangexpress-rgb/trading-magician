# ADR 0046: Demo instruments are test-only data

- **Status:** accepted
- **Date:** 2026-11-07
- **Design refs:** §6.10, §9.2, §10.2; design v1.2 item 10, row N43, open point O31; builds on
  ADR 0039 (demo data off in deployments)

## Context

ADR 0039 turned demo data off by default and migration 0051 removed demo instruments from real
databases, keeping any that someone's strategy, orders or positions used. The v1.2 brief
(item 10) asks for removal at the data level, no re-seeding, a consistent rule for leftover
references, and an Asset filter derived from the instrument store.

## Decision

- **Test-only.** The DEMO-* instruments and demo feed remain as the automated tests' data.
  `DEMO_DATA=on` is ignored on Railway (`RAILWAY_*` set) and whenever `APP_URL` is not a
  localhost URL, so no real deployment can seed them (Yong's choice, 2026-11-07).
- **Leftover references are blocked and listed.** A demo instrument with dependent records is
  not deleted. `pnpm --filter @tm/db demo:check` lists each with its account and strategy names;
  `demo:remove-unused` repeats migration 0051's clean-up for ones no longer used, and refuses to
  run where demo data is on.
- **Explicit invalid state.** With demo data off, a strategy using a demo instrument fails
  validation with `removed_instrument`, naming the instruments; a reference to an instrument that
  no longer exists says it "references a removed instrument".
- **Asset filter.** The Performance summary returns the asset classes of instruments in the
  person's books (`assetClasses`), and the Asset class filter offers only those.

## Consequences

- Tests keep running without any provider.
- A fresh install, a sign-up or a feed re-sync can't bring the demo instruments back.
