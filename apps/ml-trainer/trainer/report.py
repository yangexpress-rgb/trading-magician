"""The evaluation report of ML brief v1 §11, as Markdown plus a summary."""

from __future__ import annotations

import math
from typing import Any, Mapping


def _num(v: float | None, digits: int = 3) -> str:
    return "—" if v is None else f"{v:.{digits}f}"


def _pct(v: float | None) -> str:
    return "—" if v is None else f"{v * 100:.2f}%"


def build(model_key: str, name: str, feature_names: list[str], availability: Mapping[str, str | None], data: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    runs = data["runs"]
    universe: Mapping[str, int] = data["universe"]
    ics = [r["ic"] for r in runs if r["ic"] is not None]
    spreads = [r["decileSpread"] for r in runs if r["decileSpread"] is not None]
    mean_ic = sum(ics) / len(ics) if ics else None
    sd_ic = (
        math.sqrt(sum((x - mean_ic) ** 2 for x in ics) / (len(ics) - 1)) if mean_ic is not None and len(ics) > 1 else None
    )
    t_stat = mean_ic / (sd_ic / math.sqrt(len(ics))) if sd_ic else None
    positive = sum(1 for x in ics if x > 0) / len(ics) if ics else None
    mean_spread = sum(spreads) / len(spreads) if spreads else None
    coverage = [r["predicted"] / universe[r["date"]] for r in runs if universe.get(r["date"])]
    latest = runs[-1] if runs else None
    binding = max(((d, f) for f, d in availability.items() if d), default=None)
    snapshot_dates = sorted(universe)
    summary = {
        "model": model_key,
        "predictionDates": len(runs),
        "first": runs[0]["date"] if runs else None,
        "last": latest["date"] if latest else None,
        "evaluated": len(ics),
        "meanIc": mean_ic,
        "icTStat": t_stat,
        "shareIcPositive": positive,
        "meanDecileSpread": mean_spread,
        "meanCoverage": sum(coverage) / len(coverage) if coverage else None,
        "availability": dict(availability),
        "bindingFeature": binding[1] if binding else None,
        "firstUsableDate": binding[0] if binding else None,
        "snapshotsFrom": snapshot_dates[0] if snapshot_dates else None,
        "latestRun": latest["runNo"] if latest else None,
        "latestCoefficients": latest["coefficients"] if latest else None,
    }
    lines = [
        f"# Evaluation report — {name} (`{model_key}`)",
        "",
        "Frozen walk-forward predictions (ML brief v1 §7, ADR 0086). Each prediction date has its own refit,",
        "trained only on cross-sections whose 21-trading-day labels had fully realised before that date.",
        "",
        "## Summary",
        "",
        f"- Prediction dates: {len(runs)}" + (f" ({runs[0]['date']} to {latest['date']})" if latest else ""),
        f"- Dates with realised labels (evaluated): {len(ics)}",
        f"- Mean monthly rank IC: {_num(mean_ic)} (t-stat {_num(t_stat, 2)}; positive in {_pct(positive)} of months)",
        f"- Mean top-minus-bottom decile spread of the 21-day label: {_pct(mean_spread)}",
        f"- Mean coverage (members predicted ÷ members in the universe): {_pct(summary['meanCoverage'])}",
        "",
        "## Feature availability (§5)",
        "",
        f"Snapshots start {summary['snapshotsFrom'] or '—'}. Earliest date at which 90% of members have each feature:",
        "",
        "| Feature | Earliest date |",
        "| --- | --- |",
        *[f"| `{f}` | {availability.get(f) or 'never'} |" for f in feature_names],
        "",
        (
            f"Binding constraint: `{binding[1]}` from {binding[0]}; training starts there."
            if binding
            else "No feature reached 90% coverage."
        ),
        "",
    ]
    if latest:
        coefs = latest["coefficients"] or {}
        lines += [
            f"## Learned coefficients, latest run (run {latest['runNo']}, for {latest['date']}, trained through {latest['trainingEnd']})",
            "",
            "Features are cross-sectional z-scores; the sign is the direction the model learned (a value feature with the wrong sign is visible here).",
            "",
            "| Feature | Coefficient | Sign |",
            "| --- | ---: | --- |",
            *[
                f"| `{f}` | {_num(coefs.get(f), 5)} | {'+' if (coefs.get(f) or 0) > 0 else '−' if (coefs.get(f) or 0) < 0 else '0'} |"
                for f in feature_names
            ],
            f"| (intercept) | {_num(coefs.get('(intercept)'), 5)} | |",
            "",
            f"Alpha {latest['hyperparams'].get('alpha')}; validation mean IC by alpha: "
            + ", ".join(f"{k}: {_num(v)}" for k, v in (latest["hyperparams"].get("cvMeanIc") or {}).items()),
            "",
        ]
    lines += [
        "## Monthly series",
        "",
        "| Date | Run | Trained through | Max label end | Cross-sections | Predicted / universe | IC | Decile spread |",
        "| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |",
        *[
            f"| {r['date']} | {r['runNo']} | {r['trainingEnd']} | {r['maxLabelEnd']} | {r['crossSections']} | "
            f"{r['predicted']} / {universe.get(r['date'], 0)} | {_num(r['ic'])} | {_pct(r['decileSpread'])} |"
            for r in runs
        ],
        "",
        "## Caveats",
        "",
        "- The universe is today's S&P 500 members (survivorship bias): earlier years leave out companies",
        "  that have since left the index, which flatters any long-only result.",
        "- Fundamentals reach back only as far as the point-in-time EDGAR replay supports (see availability).",
        "- Scores are monthly: `ml.score` is for monthly or quarterly strategies.",
        "",
    ]
    return "\n".join(lines), summary
