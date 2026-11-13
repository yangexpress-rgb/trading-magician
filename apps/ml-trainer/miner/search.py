"""Beam search on the discovery window and one-time holdout verification (brief §7).

Grids are packed into bitsets over the flattened (day, instrument) cells, so
a conjunction is a bitwise AND and a count is a popcount.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .atoms import Atom
from .stats import benjamini_hochberg, binomial_p_upper, wilson_lower, wilson_lower_many

BEAM_WIDTH = 200
FINALISTS = 50
REDUNDANT_SHARE = 0.8
HOLDOUT_MIN_N = 15
MIN_LIFT = 1.25
FDR_Q = 0.10


def pack(grid: np.ndarray) -> np.ndarray:
    """A boolean grid as a uint64 bitset."""
    bits = np.packbits(grid.ravel().astype(bool))
    pad = (-len(bits)) % 8
    if pad:
        bits = np.concatenate([bits, np.zeros(pad, dtype=np.uint8)])
    return bits.view(np.uint64)


def popcount(bits: np.ndarray) -> int:
    return int(np.bitwise_count(bits).sum())


def popcount_rows(bits: np.ndarray) -> np.ndarray:
    return np.bitwise_count(bits).sum(axis=-1, dtype=np.int64)


@dataclass
class Rule:
    atoms: tuple[int, ...]  # indexes into the atom list, in the order added
    bits: np.ndarray
    n: int
    hits: int
    lower: float
    level: int

    @property
    def key(self) -> frozenset[int]:
        return frozenset(self.atoms)


@dataclass
class WindowStats:
    n: int
    hits: int
    rate: float
    base_rate: float
    lift: float
    lower: float
    p_value: float | None = None

    def as_json(self) -> dict[str, float | int | None]:
        return {
            "n": self.n,
            "hits": self.hits,
            "rate": self.rate,
            "baseRate": self.base_rate,
            "lift": self.lift,
            "wilsonLower": self.lower,
            "pValue": self.p_value,
        }


@dataclass
class Finalist:
    rule: Rule
    discovery: WindowStats
    holdout: WindowStats
    verified: bool
    reasons: list[str] = field(default_factory=list)


@dataclass
class SearchResult:
    candidates_tested: int
    levels: list[int]
    finalists: list[Finalist]
    suppressed: int
    discovery_base: float
    holdout_base: float
    discovery_cells: int
    holdout_cells: int


def window_stats(bits: np.ndarray, usable: np.ndarray, hit: np.ndarray, base: float) -> WindowStats:
    occ = bits & usable
    n = popcount(occ)
    h = popcount(occ & hit)
    rate = h / n if n else 0.0
    return WindowStats(n, h, rate, base, (rate / base) if base > 0 else 0.0, wilson_lower(h, n))


def beam_search(
    atoms: list[tuple[Atom, np.ndarray]],
    usable_disc: np.ndarray,
    usable_hold: np.ndarray,
    hit: np.ndarray,
    *,
    max_depth: int = 3,
    min_support: int = 40,
    beam_width: int = BEAM_WIDTH,
    finalists: int = FINALISTS,
) -> SearchResult:
    """§7: beam search on discovery bitsets, redundancy suppression, holdout verification."""
    factor_of = [a.factor for a, _ in atoms]
    atom_bits = np.stack([a_bits & usable_disc for _, a_bits in atoms]) if atoms else np.zeros((0, len(usable_disc)), dtype=np.uint64)
    full_bits = [a_bits for _, a_bits in atoms]
    disc_hit = usable_disc & hit
    n_disc = popcount(usable_disc)
    base_disc = popcount(disc_hit) / n_disc if n_disc else 0.0
    n_hold = popcount(usable_hold)
    base_hold = popcount(usable_hold & hit) / n_hold if n_hold else 0.0

    def bits_of(idx: tuple[int, ...]) -> np.ndarray:
        b = full_bits[idx[0]].copy()
        for i in idx[1:]:
            b &= full_bits[i]
        return b

    tested = 0
    levels: list[int] = []
    # Level 1: every atom.
    n1 = popcount_rows(atom_bits) if len(atoms) else np.zeros(0, dtype=np.int64)
    h1 = popcount_rows(atom_bits & disc_hit) if len(atoms) else np.zeros(0, dtype=np.int64)
    lb1 = wilson_lower_many(h1, n1)
    tested += len(atoms)
    levels.append(len(atoms))
    # Every rule kept at any level, without bitsets (rebuilt for the few that need them).
    pool: dict[frozenset[int], Rule] = {}
    current: list[Rule] = []
    for i in range(len(atoms)):
        if n1[i] >= min_support:
            r = Rule((i,), full_bits[i], int(n1[i]), int(h1[i]), float(lb1[i]), 1)
            current.append(r)
            pool[r.key] = Rule(r.atoms, np.empty(0, np.uint64), r.n, r.hits, r.lower, 1)
    for level in range(2, max_depth + 1):
        beam = sorted(current, key=lambda r: (-r.lower, r.atoms))[:beam_width]
        found: dict[frozenset[int], tuple[tuple[int, ...], int, int, float]] = {}
        parent_best: dict[frozenset[int], float] = {}
        count = 0
        for parent in beam:
            used = {factor_of[i] for i in parent.atoms}
            allowed = [i for i in range(len(atoms)) if factor_of[i] not in used]
            if not allowed:
                continue
            kids_disc = atom_bits[allowed] & parent.bits
            n = popcount_rows(kids_disc)
            h = popcount_rows(kids_disc & disc_hit)
            lb = wilson_lower_many(h, n)
            for j, i in enumerate(allowed):
                key = frozenset((*parent.atoms, i))
                # A conjunction reached from several parents must beat the best of them.
                parent_best[key] = max(parent_best.get(key, -1.0), parent.lower)
                if key in found or key in pool:
                    continue
                count += 1
                if n[j] >= min_support:
                    found[key] = ((*parent.atoms, i), int(n[j]), int(h[j]), float(lb[j]))
        tested += count
        levels.append(count)
        improved = [(k, v) for k, v in found.items() if v[3] > parent_best[k]]
        if not improved:
            break
        for k, (idx, n_, h_, lb_) in improved:
            pool[k] = Rule(idx, np.empty(0, np.uint64), n_, h_, lb_, level)
        best = sorted(improved, key=lambda kv: (-kv[1][3], kv[1][0]))[:beam_width]
        current = [Rule(idx, bits_of(idx), n_, h_, lb_, level) for _, (idx, n_, h_, lb_) in best]

    ranked = sorted(pool.values(), key=lambda r: (-r.lower, r.level, r.atoms))[:finalists]
    for r in ranked:
        r.bits = bits_of(r.atoms)
    kept: list[Rule] = []
    suppressed = 0
    for r in ranked:
        occ = r.bits & usable_disc
        n = popcount(occ)
        if any(n and popcount(occ & k.bits) >= REDUNDANT_SHARE * n for k in kept):
            suppressed += 1
            continue
        kept.append(r)

    out: list[Finalist] = []
    for r in kept:
        disc = window_stats(r.bits, usable_disc, hit, base_disc)
        hold = window_stats(r.bits, usable_hold, hit, base_hold)
        hold.p_value = binomial_p_upper(hold.hits, hold.n, base_hold)
        out.append(Finalist(r, disc, hold, False))
    survives = benjamini_hochberg([f.holdout.p_value or 1.0 for f in out], FDR_Q)
    for f, ok in zip(out, survives):
        h = f.holdout
        if h.n < HOLDOUT_MIN_N:
            f.reasons.append(f"holdout n {h.n} < {HOLDOUT_MIN_N}")
        if not h.lower > h.base_rate:
            f.reasons.append("holdout Wilson lower bound not above the base rate")
        if not h.lift >= MIN_LIFT:
            f.reasons.append(f"holdout lift {h.lift:.2f} < {MIN_LIFT}")
        if not ok:
            f.reasons.append(f"fails Benjamini-Hochberg at q = {FDR_Q}")
        f.verified = not f.reasons
    return SearchResult(
        candidates_tested=tested,
        levels=levels,
        finalists=out,
        suppressed=suppressed,
        discovery_base=base_disc,
        holdout_base=base_hold,
        discovery_cells=n_disc,
        holdout_cells=n_hold,
    )
