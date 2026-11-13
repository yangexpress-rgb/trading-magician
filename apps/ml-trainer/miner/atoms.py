"""Atoms (brief §4): a factor plus a bucket test, true / false / unknown per cell.

- Cross-sectional: on each day, quintiles across the universe members with a
  known value; at least 50 known that day, else unknown. Top quintile: the
  value's rank among the day's known values is in the top fifth; bottom: the
  bottom fifth (ranks by value, ties sharing the lower rank).
- Own history: the value's percentile rank among the instrument's previous
  (up to) 252 known values, at least 120 of them: at or above the 90th, or at
  or below the 10th. Today's value is not in its own reference set.

Only "true" matters to a conjunction (an occurrence needs every atom true), so
an atom is a boolean grid; unknown and false are both False.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_CROSS_SECTION = 50
OWN_WINDOW = 252
MIN_OWN_HISTORY = 120


@dataclass(frozen=True)
class Atom:
    factor: str
    mode: str  # 'cross' | 'own'
    bucket: str  # 'top' | 'bottom' (cross), 'high' | 'low' (own)

    @property
    def key(self) -> str:
        return f"{self.factor}|{self.mode}|{self.bucket}"

    def as_json(self) -> dict[str, str]:
        return {"factor": self.factor, "mode": self.mode, "bucket": self.bucket}


def cross_quintiles(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(top, bottom) boolean grids for a (days, instruments) value grid with NaN unknown."""
    days, _ = values.shape
    top = np.zeros(values.shape, dtype=bool)
    bottom = np.zeros(values.shape, dtype=bool)
    for d in range(days):
        row = values[d]
        known = ~np.isnan(row)
        n = int(known.sum())
        if n < MIN_CROSS_SECTION:
            continue
        v = row[known]
        # Rank = how many known values are strictly below (ties share the lower rank).
        sorted_v = np.sort(v)
        rank = np.searchsorted(sorted_v, v, side="left")
        frac = rank / n
        idx = np.flatnonzero(known)
        top[d, idx[frac >= 0.8]] = True
        bottom[d, idx[frac < 0.2]] = True
    return top, bottom


def own_percentiles(values: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(high, low) boolean grids: >= 90th or <= 10th percentile of own trailing known values."""
    high = np.zeros(values.shape, dtype=bool)
    low = np.zeros(values.shape, dtype=bool)
    _, inst = values.shape
    for i in range(inst):
        col = values[:, i]
        where = np.flatnonzero(~np.isnan(col))
        if len(where) <= MIN_OWN_HISTORY:
            continue
        seq = col[where]
        for j in range(MIN_OWN_HISTORY, len(seq)):
            ref = seq[max(0, j - OWN_WINDOW) : j]
            # Percentile rank of today's value among the reference values (ties count half).
            pr = (np.count_nonzero(ref < seq[j]) + 0.5 * np.count_nonzero(ref == seq[j])) / len(ref)
            if pr >= 0.9:
                high[where[j], i] = True
            elif pr <= 0.1:
                low[where[j], i] = True
    return high, low


def build_atoms(factors: dict[str, np.ndarray], modes: dict[str, list[str]]) -> list[tuple[Atom, np.ndarray]]:
    """Every atom of every factor in `factors` (grid per factor id), by the modes each offers."""
    out: list[tuple[Atom, np.ndarray]] = []
    for fid in sorted(factors):
        grid = factors[fid]
        for mode in modes.get(fid, []):
            if mode == "cross":
                top, bottom = cross_quintiles(grid)
                out.append((Atom(fid, "cross", "top"), top))
                out.append((Atom(fid, "cross", "bottom"), bottom))
            elif mode == "own":
                high, low = own_percentiles(grid)
                out.append((Atom(fid, "own", "high"), high))
                out.append((Atom(fid, "own", "low"), low))
    return out
