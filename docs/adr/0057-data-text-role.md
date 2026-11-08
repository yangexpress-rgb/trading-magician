# ADR 0057: A data text role that sets values apart from titles

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §5.1, §15; design v1.2 rows N125 to N131, open points O100 to O102; the design
  brief "Make transactional data look different from titles" (Yong, 2026-11-08, decisions D1 to
  D7)

## Context

Titles, labels and values were all set in one voice: the proportional system sans at similar
weights. A back test return, a price, a date and a strategy name looked alike, so the eye could not
tell at a glance what was a label and what was a value. Where pages did something about it
(`tabular-nums` on some cells, `text-right` on some columns, `font-mono` on identifiers) each page
decided on its own.

## Decision

- **One named style for values.** `text-data` is the sans stack with tabular (fixed-width)
  figures, medium weight, colour ink; `text-data-strong` is the same at semibold for the one primary
  figure on a stat card or detail page. Both live in `packages/ui/src/styles.css`.
- **Components layer, not `@utility`.** The two classes are the default look of a value. Placing
  them in the CSS components layer lets any utility on the same element win: a status colour
  (`text-danger`), a muted tone for a missing value, or a heavier weight. The status colour rule
  (§5.1: never colour alone) is untouched and no page needs to know the order of generated CSS.
- **Shared cells and figures.** `Td numeric` / `TdNumeric` right-aligns a numeric cell in
  `text-data`; `Th numeric` puts its header on the same edge. `DataValue` and `Stat` render a label
  and a value (or a stat card figure) and show `—` for a missing value.
- **Numeric inputs** (`type="number"`, `inputmode` decimal or numeric) are right-aligned with
  tabular figures by one base rule, so every form, the Strategy Lab builder included, follows it
  without per-page changes.
- **Mono means identifier.** `font-mono` stays for registration numbers, member IDs, commit hashes
  and tickers. Library parameter values move from mono to `text-data`.

## Consequences

- No webfont, no new colour token, no new font size, no dependency, no data or API change.
  Formatted values read exactly as before.
- Units stay where the formatters put them (O101); a dedicated data font is left open (O100).
- `apps/web/vitest.config.ts` now compiles JSX and resolves `@/`, so web tests can render a
  component to static markup (used by the back test runs table test).
