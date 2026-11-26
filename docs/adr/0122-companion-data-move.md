# ADR 0122: The data move to the Local Companion

- **Status:** accepted
- **Date:** 2026-11-26
- **Design refs:** design v1.3 §17.4; N349; migration 0117. S2 plan step 5. Builds on ADR 0115
  (the S1 move) and 0118 (data requests).

## Context

Before the hand-over switch (ADR 0121) goes on, the companion's local Research Store needs the
cloud's research history. That history is about 3 GB on staging, most of it the factor store.
Without it, the companion would rebuild years of factor snapshots by fetching bars through the
admin's Alpaca budget, and decay could not score older patterns from the local store. The cloud
Research database has no public port, and the brief keeps the companion's credentials to the
`research_sync` pairing.

## Decision

- **Through a data request, slice by slice.** A new request kind, `research_export`, takes a
  table and a starting page. The worker answers with that table's columns, its size in pages, and
  the rows of 256 heap pages (about 2 MB) as one JSON array. It reads the slice the same way the S1
  move reads Core (ADR 0115), with its own login, which sees every person's rows. Only the
  producer's companion can ask (O217).
- **Every research table except back test trades.** Back test trades stay in the cloud, as decided
  in the S2 plan on 2026-11-25. Raw option chains are copied too, and they become the companion's
  archive.
- **The companion inserts each slice with ON CONFLICT DO NOTHING**, parents first. It checks that
  the cloud's columns match its own, and it never overwrites rows it made itself. Any row whose
  parent isn't present is counted.
- **Verification as in S1.** `tm-companion move-data` runs a copy pass and then a second pass. The
  move is VERIFIED when the second pass copies nothing, leaves nothing out, and every local table
  holds at least the cloud's row count. The command writes a JSON report next to the local data.
- **The cloud's copies are not touched.** Dropping them is a separate step, taken only after
  verification and Yong's explicit go-ahead in chat.

## Consequences

- The move runs once, on the producer's computer, before `tm-companion run` starts its jobs. A
  repeat run is safe.
- Each slice is held briefly in Core's request queue and deleted once read.
- The answer for a large table holds a few MB of JSON in memory on the worker and the companion.

## Amendment (2026-11-26, N350)

The first live move on staging copied 16 finished scans, one ML evaluation and one report. The
companion then tried to push them back as its own, and the largest scan (about 492,000
occurrences) hit the inbox's 4 MB limit. Two changes follow:

- **What came from the cloud is marked as sent.** After a verified move, and on demand with
  `tm-companion mark-cloud-copies`, the companion reads the cloud's scans, patterns, evaluations
  and reports again and marks them in `companion.pushed`: finished scans, the decay score each
  Verified pattern holds in the cloud, each evaluation and each report. The cloud's own values
  decide, so a scan or score made on the companion since still goes up. The cloud's last score of
  each pattern is recorded in `companion.decay_pulled`.
- **A big scan result goes up in parts.** The companion sends at most 15,000 occurrences per
  push. Every part but the last carries `partial: true`: its patterns and occurrences go in (with
  ON CONFLICT DO NOTHING), and the scan stays as it is. The last part, under the scan's own key,
  sets the scan's outcome.
