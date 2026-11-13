"""Decay monitoring and re-verification (brief §10), on in-memory grids.

Weekly, every Verified pattern is re-scored on occurrences strictly after its
holdout window ended (fresh data only). With at least 10 fresh occurrences:
Broken when the fresh hit rate is at or below the fresh base rate; Weakening
when it beats the base rate but its Wilson lower bound does not, or lift is
under 1.1; otherwise Holding. Fewer than 10 leaves the state unset.

Re-verify runs §7's gate on all data after the discovery window as one fresh
holdout (one test, so BH reduces to p <= q).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .atoms import Atom, cross_quintiles, own_percentiles
from .labels import Outcomes
from .scan import Occurrence
from .search import FDR_Q, HOLDOUT_MIN_N, MIN_LIFT, WindowStats
from .stats import binomial_p_upper, wilson_lower

DECAY_MIN_N = 10
WEAK_LIFT = 1.1


def rule_mask(factors: dict[str, np.ndarray], rule: list[Atom]) -> np.ndarray:
    """Where every atom of the rule is true (unknown counts as false)."""
    shape = next(iter(factors.values())).shape
    mask = np.ones(shape, dtype=bool)
    cache: dict[tuple[str, str], tuple[np.ndarray, np.ndarray]] = {}
    for a in rule:
        grid = factors.get(a.factor)
        if grid is None:
            return np.zeros(shape, dtype=bool)
        key = (a.factor, a.mode)
        if key not in cache:
            cache[key] = cross_quintiles(grid) if a.mode == "cross" else own_percentiles(grid)
        first, second = cache[key]
        mask &= first if a.bucket in ("top", "high") else second
    return mask


@dataclass
class FreshScore:
    stats: WindowStats
    occurrences: list[Occurrence]


def score_after(
    factors: dict[str, np.ndarray],
    rule: list[Atom],
    outcomes: Outcomes,
    *,
    direction: str,
    threshold: float,
    after: int,
    horizon: int,
    window: str = "fresh",
) -> FreshScore:
    """The rule's statistics on days strictly after day index `after` whose horizon is in the data."""
    days, _ = outcomes.forward.shape
    usable = np.zeros(outcomes.forward.shape, dtype=bool)
    idx = np.arange(days)
    usable[(idx > after) & (idx + horizon <= days - 1)] = True
    usable &= outcomes.known()
    hit = outcomes.hits(direction, threshold)
    cells = int(usable.sum())
    base = float((hit & usable).sum() / cells) if cells else 0.0
    occ = rule_mask(factors, rule) & usable
    n = int(occ.sum())
    h = int((occ & hit).sum())
    rate = h / n if n else 0.0
    stats = WindowStats(
        n, h, rate, base, (rate / base) if base > 0 else 0.0, wilson_lower(h, n), binomial_p_upper(h, n, base)
    )
    rows = [
        Occurrence(
            int(d), int(i), window, bool(hit[d, i]),
            float(outcomes.runup[d, i]), float(outcomes.drawdown[d, i]), float(outcomes.forward[d, i]),
        )
        for d, i in zip(*np.nonzero(occ))
    ]
    return FreshScore(stats, rows)


def decay_state(s: WindowStats) -> str | None:
    """Holding / Weakening / Broken, or None below 10 fresh occurrences (§10)."""
    if s.n < DECAY_MIN_N:
        return None
    if s.rate <= s.base_rate:
        return "broken"
    if s.lower <= s.base_rate or s.lift < WEAK_LIFT:
        return "weakening"
    return "holding"


def reverify_checks(s: WindowStats) -> list[str]:
    """§7's gate on one fresh holdout; empty when it passes."""
    failed: list[str] = []
    if s.n < HOLDOUT_MIN_N:
        failed.append(f"holdout n {s.n} < {HOLDOUT_MIN_N}")
    if not s.lower > s.base_rate:
        failed.append("holdout Wilson lower bound not above the base rate")
    if not s.lift >= MIN_LIFT:
        failed.append(f"holdout lift {s.lift:.2f} < {MIN_LIFT}")
    if s.p_value is None or s.p_value > FDR_Q:
        failed.append(f"p-value above q = {FDR_Q}")
    return failed
