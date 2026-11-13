"""Excursion outcomes (brief §2, §5) from the stored bar ratios.

Each snapshot row stores its day's close, high and low as ratios to the
previous adjusted close (O160). Chaining them gives the path after an
occurrence day t, relative to t's close: the high k days on is
prod(1 + close_ret[t+1 .. t+k-1]) * (1 + high_rel[t+k]). A window with any
missing day (no row, or no ratios) is unknown, never guessed.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Outcomes:
    """Per (day, instrument): realised max run-up, max drawdown, forward return at H; NaN unknown."""

    runup: np.ndarray
    drawdown: np.ndarray
    forward: np.ndarray

    def known(self) -> np.ndarray:
        return ~np.isnan(self.forward)

    def hits(self, direction: str, threshold: float) -> np.ndarray:
        """Spike: run-up >= X; plunge: drawdown <= -X. False where unknown."""
        with np.errstate(invalid="ignore"):
            if direction == "spike":
                return np.nan_to_num(self.runup, nan=-np.inf) >= threshold
            return np.nan_to_num(self.drawdown, nan=np.inf) <= -threshold


def excursions(close_ret: np.ndarray, high_rel: np.ndarray, low_rel: np.ndarray, horizon: int) -> Outcomes:
    """Outcomes for every cell of a (days, instruments) grid over the next `horizon` rows."""
    days, inst = close_ret.shape
    runup = np.full((days, inst), np.nan)
    drawdown = np.full((days, inst), np.nan)
    forward = np.full((days, inst), np.nan)
    if horizon < 1 or days <= horizon:
        return Outcomes(runup, drawdown, forward)
    n = days - horizon
    cum = np.ones((n, inst))
    best = np.full((n, inst), -np.inf)
    worst = np.full((n, inst), np.inf)
    ok = np.ones((n, inst), dtype=bool)
    for k in range(1, horizon + 1):
        c = close_ret[k : k + n]
        h = high_rel[k : k + n]
        lo = low_rel[k : k + n]
        ok &= ~(np.isnan(c) | np.isnan(h) | np.isnan(lo))
        best = np.maximum(best, cum * (1 + np.nan_to_num(h)))
        worst = np.minimum(worst, cum * (1 + np.nan_to_num(lo)))
        cum = cum * (1 + np.nan_to_num(c))
    runup[:n] = np.where(ok, best - 1, np.nan)
    drawdown[:n] = np.where(ok, worst - 1, np.nan)
    forward[:n] = np.where(ok, cum - 1, np.nan)
    return Outcomes(runup, drawdown, forward)
