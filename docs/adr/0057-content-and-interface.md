# ADR 0057: Content set apart from the interface

- **Status:** accepted
- **Date:** 2026-11-08
- **Design refs:** §5.1, §15; design v1.2 rows N126 to N134, open points O101 to O105; Yong's design
  brief v2.2 "Tell content apart from interface (all text, not just numbers)", decisions D1 to D8
  (it supersedes the first brief, "make transactional data look different from titles")

## Context

The app had one voice: a strategy's name, its description, a section heading and the rule prose
were all the same ink, sans and weight, and the only distinction was small muted labels. The eye
could not tell the app talking (titles, labels, buttons) from the substance (what the user typed,
or what the app produced as a strategy, a back test or an order).

## Decision

- **Two roles.** Interface keeps the neutral ink and muted tones; labels are muted, small and
  semibold. Content is set in `text-content`: one new colour token, `--tm-content` (`#1e3a5f`
  light, `#a9c6e8` dark; at least 9:1 on every surface), medium weight, tabular figures, the system
  sans. `text-content-strong` is the one primary figure on a card or page. Long prose adds relaxed
  leading and a prose measure.
- **Components layer, not `@utility` (O105).** The classes are the default look of content, so any
  utility on the same element wins: a status colour on a loss, a muted tone on a missing value,
  `font-mono` on an identifier. The status-colour rule (§5.1) stands.
- **Shared pieces.** `Td` sets content by default; `Td numeric` / `TdNumeric` right-aligns and
  `Th numeric` matches. `DataValue` and `Stat` render a label with a value and show `—` for a
  missing value. Typed text in inputs and text areas is content by one base rule; numeric fields are
  also right-aligned.
- **Units in headers (O102).** Money and percentage columns name their unit in the header; the cells
  show the formatter's digits, decimals and sign without the symbol (`bare` in
  `apps/web/lib/units.ts`).
- **Reading text (N134).** Long text (Library prose, rules, descriptions) uses `text-prose`: the
  content colour at regular weight, proportional figures and relaxed leading, on a scale of 30px
  title, 18px card headings, 14px muted labels and 16px values, following how TradingView builds
  hierarchy from size, weight and grey on one system font.
- **No data font (O101).** Inter was briefly bundled, then dropped at Yong's choice; system stacks
  only.

## Consequences

- Exactly one new colour token; no font size, webfont, dependency, data or API change.
- `apps/web/vitest.config.ts` compiles JSX and resolves `@/`, so web tests can render a component
  to static markup.
