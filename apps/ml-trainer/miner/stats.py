"""Interval and test statistics for the verification gate (brief §7)."""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import binom

Z95 = 1.959963984540054


def wilson_lower(hits: int, n: int, z: float = Z95) -> float:
    """The Wilson score interval's lower bound for hits out of n (0 when n is 0)."""
    if n <= 0:
        return 0.0
    p = hits / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (centre - margin) / denom)


def wilson_lower_many(hits: np.ndarray, n: np.ndarray, z: float = Z95) -> np.ndarray:
    """Vectorised Wilson lower bound; 0 where n is 0."""
    n_f = n.astype(np.float64)
    safe = np.where(n_f > 0, n_f, 1.0)
    p = hits / safe
    denom = 1 + z * z / safe
    centre = p + z * z / (2 * safe)
    margin = z * np.sqrt(np.maximum(p * (1 - p) / safe + z * z / (4 * safe * safe), 0.0))
    return np.where(n_f > 0, np.maximum(0.0, (centre - margin) / denom), 0.0)


def binomial_p_upper(hits: int, n: int, base: float) -> float:
    """One-sided p-value: P(X >= hits) for X ~ Binomial(n, base); 1 without occurrences."""
    if n <= 0 or hits <= 0:
        return 1.0
    if base <= 0:
        return 0.0
    if base >= 1:
        return 1.0
    return float(binom.sf(hits - 1, n, base))


def benjamini_hochberg(pvalues: list[float], q: float) -> list[bool]:
    """Which hypotheses BH rejects at false-discovery rate q."""
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda i: pvalues[i])
    cutoff = -1
    for rank, i in enumerate(order, start=1):
        if pvalues[i] <= rank / m * q:
            cutoff = rank
    keep = [False] * m
    for rank, i in enumerate(order, start=1):
        if rank <= cutoff:
            keep[i] = True
    return keep
