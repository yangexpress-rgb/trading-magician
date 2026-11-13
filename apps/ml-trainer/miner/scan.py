"""One scan end to end on in-memory grids (brief §5–§7), independent of the database."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .atoms import Atom, build_atoms
from .labels import Outcomes
from .search import SearchResult, beam_search, pack

DISCOVERY_SHARE = 0.7


@dataclass(frozen=True)
class Windows:
    """Day indexes: the scan range [start, end] split into discovery and holdout (§7)."""

    start: int
    disc_end: int  # last discovery day
    end: int
    horizon: int

    def usable_days(self) -> tuple[np.ndarray, np.ndarray]:
        """Per day index, whether an occurrence that day is usable in discovery / holdout (§5)."""
        days = np.arange(self.end + 1)
        disc = (days >= self.start) & (days <= self.disc_end) & (days + self.horizon <= self.disc_end)
        hold = (days > self.disc_end) & (days <= self.end) & (days + self.horizon <= self.end)
        return disc, hold


def split(start: int, end: int, horizon: int, share: float = DISCOVERY_SHARE) -> Windows:
    """Discovery = the first `share` of the range's trading days, holdout the rest."""
    count = end - start + 1
    disc_days = int(np.floor(count * share))
    return Windows(start, start + disc_days - 1, end, horizon)


@dataclass
class Occurrence:
    day: int
    inst: int
    window: str
    hit: bool
    runup: float
    drawdown: float
    forward: float


@dataclass
class ScanOutput:
    result: SearchResult
    atoms: list[Atom]
    windows: Windows
    occurrences: list[list[Occurrence]]


def mine(
    factors: dict[str, np.ndarray],
    modes: dict[str, list[str]],
    outcomes: Outcomes,
    *,
    direction: str,
    threshold: float,
    windows: Windows,
    max_depth: int = 3,
    min_support: int = 40,
) -> ScanOutput:
    """Atoms, labels and the §7 search and verification for one outcome over one range."""
    days, inst = outcomes.forward.shape
    disc_days, hold_days = windows.usable_days()
    known = outcomes.known()
    usable_disc_grid = np.zeros((days, inst), dtype=bool)
    usable_hold_grid = np.zeros((days, inst), dtype=bool)
    usable_disc_grid[: len(disc_days)] = disc_days[:, None]
    usable_hold_grid[: len(hold_days)] = hold_days[:, None]
    usable_disc_grid &= known
    usable_hold_grid &= known
    hit_grid = outcomes.hits(direction, threshold)
    built = build_atoms(factors, modes)
    packed = [(a, pack(g)) for a, g in built]
    result = beam_search(
        packed,
        pack(usable_disc_grid),
        pack(usable_hold_grid),
        pack(hit_grid),
        max_depth=max_depth,
        min_support=min_support,
    )
    atom_list = [a for a, _ in built]
    grids = [g for _, g in built]
    occ: list[list[Occurrence]] = []
    for f in result.finalists:
        mask = np.ones((days, inst), dtype=bool)
        for i in f.rule.atoms:
            mask &= grids[i]
        rows: list[Occurrence] = []
        for window, usable in (("discovery", usable_disc_grid), ("holdout", usable_hold_grid)):
            for d, i in zip(*np.nonzero(mask & usable)):
                rows.append(
                    Occurrence(
                        int(d),
                        int(i),
                        window,
                        bool(hit_grid[d, i]),
                        float(outcomes.runup[d, i]),
                        float(outcomes.drawdown[d, i]),
                        float(outcomes.forward[d, i]),
                    )
                )
        occ.append(rows)
    return ScanOutput(result, atom_list, windows, occ)
