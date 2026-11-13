"""Pattern discovery's acceptance fixtures 1–5 (pattern brief §13)."""

from __future__ import annotations

import numpy as np

from miner.labels import Outcomes, excursions
from miner.scan import mine, split
from miner.search import beam_search, pack

DAYS, INST = 800, 120


def outcomes_from_hits(hit: np.ndarray) -> Outcomes:
    """Outcomes whose run-up is 10% where hit, 1% otherwise; all known."""
    runup = np.where(hit, 0.10, 0.01)
    return Outcomes(runup, -runup, runup / 2)


def noise_factors(rng: np.random.Generator, count: int) -> dict[str, np.ndarray]:
    return {f"f{k:02d}": rng.standard_normal((DAYS, INST)) for k in range(count)}


def modes_for(factors: dict[str, np.ndarray]) -> dict[str, list[str]]:
    return {f: ["cross"] for f in factors}


def test_fixture_1_noise_verifies_nothing():
    """Random factors, outcomes at the base rate: the gate must verify zero patterns."""
    for seed in range(3):
        rng = np.random.default_rng(seed)
        factors = noise_factors(rng, 20)
        hit = rng.random((DAYS, INST)) < 0.3
        out = mine(
            factors,
            modes_for(factors),
            outcomes_from_hits(hit),
            direction="spike",
            threshold=0.08,
            windows=split(0, DAYS - 1, 15),
        )
        assert out.result.candidates_tested > 1000, out.result.levels
        assert len(out.result.finalists) > 0
        assert [f for f in out.result.finalists if f.verified] == []


def test_fixture_2_planted_rule_is_found_and_verified():
    """One 2-atom rule spikes 80% of the time against a 30% base rate, in both windows."""
    rng = np.random.default_rng(42)
    factors = noise_factors(rng, 10)
    a, b = factors["f03"], factors["f07"]
    top = lambda g: g >= np.quantile(g, 0.8, axis=1, keepdims=True)  # noqa: E731
    planted = top(a) & top(b)
    hit = np.where(planted, rng.random((DAYS, INST)) < 0.8, rng.random((DAYS, INST)) < 0.3)
    out = mine(
        factors,
        modes_for(factors),
        outcomes_from_hits(hit),
        direction="spike",
        threshold=0.08,
        windows=split(0, DAYS - 1, 15),
    )
    verified = [f for f in out.result.finalists if f.verified]
    assert verified, [f.reasons for f in out.result.finalists[:3]]
    best = verified[0]
    names = {(out.atoms[i].factor, out.atoms[i].bucket) for i in best.rule.atoms}
    if not {("f03", "top"), ("f07", "top")} <= names:
        # Otherwise a rule covering at least 80% of the planted rule's occurrences.
        occ = {(o.day, o.inst) for o in out.occurrences[0]}
        planted_cells = set(zip(*np.nonzero(planted)))
        assert len(occ & planted_cells) >= 0.8 * len(planted_cells & occ | occ)
    h = best.holdout
    assert 0.7 <= h.rate <= 0.9
    assert 0.25 <= h.base_rate <= 0.35
    assert h.lift > 2
    assert best.discovery.n >= 40


def test_fixture_3_embargo():
    """An occurrence whose horizon crosses the discovery/holdout boundary counts in neither window."""
    w = split(0, 99, horizon=5)
    assert w.disc_end == 69
    disc, hold = w.usable_days()
    # Day 64 + 5 = 69: fully inside discovery. Day 65's horizon ends on day 70 (holdout).
    assert disc[64] and not disc[65]
    for d in range(65, 70):
        assert not disc[d] and not hold[d]
    assert hold[70] and hold[94] and not hold[95]
    # And through the search: a rule true only on day 66 is counted in neither window.
    hit = np.ones((100, 60), dtype=bool)
    only66 = np.zeros((100, 60), dtype=bool)
    only66[66] = True
    usable_d = np.zeros((100, 60), dtype=bool)
    usable_d[disc] = True
    usable_h = np.zeros((100, 60), dtype=bool)
    usable_h[hold[:100]] = True
    from miner.atoms import Atom

    res = beam_search([(Atom("x", "cross", "top"), pack(only66))], pack(usable_d), pack(usable_h), pack(hit), min_support=1)
    assert res.levels[0] == 1
    assert res.finalists == []


def test_fixture_4_labelling_worked_example():
    """§5: close 100, H = 3, X = 8%. Highs 104, 109, 103; lows 98, 97, 101."""
    closes = [100.0, 102.0, 105.0, 102.0]
    highs = [None, 104.0, 109.0, 103.0]
    lows = [None, 98.0, 97.0, 101.0]
    close_ret = np.full((4, 1), np.nan)
    high_rel = np.full((4, 1), np.nan)
    low_rel = np.full((4, 1), np.nan)
    for k in range(1, 4):
        prev = closes[k - 1]
        close_ret[k, 0] = closes[k] / prev - 1
        high_rel[k, 0] = highs[k] / prev - 1
        low_rel[k, 0] = lows[k] / prev - 1
    o = excursions(close_ret, high_rel, low_rel, horizon=3)
    assert abs(o.runup[0, 0] - 0.09) < 1e-12
    assert abs(o.drawdown[0, 0] - (-0.03)) < 1e-12
    assert abs(o.forward[0, 0] - 0.02) < 1e-12
    assert bool(o.hits("spike", 0.08)[0, 0]) is True
    assert bool(o.hits("plunge", 0.08)[0, 0]) is False
    assert bool(o.hits("plunge", 0.03)[0, 0]) is True
    # The last H days have no complete window: unknown, and never a hit.
    assert np.isnan(o.forward[1:, 0]).all()
    assert not o.hits("spike", 0.0)[1:, 0].any()
    # A missing day inside the window makes the outcome unknown.
    gap = high_rel.copy()
    gap[2, 0] = np.nan
    assert np.isnan(excursions(close_ret, gap, low_rel, horizon=3).forward[0, 0])


def test_fixture_5_redundancy():
    """Two finalists sharing at least 80% of their occurrences: only the higher-ranked survives."""
    rng = np.random.default_rng(7)
    days, inst = 400, 80
    base = rng.random((days, inst)) < 0.1
    nearly = base.copy()
    flip = np.flatnonzero(base.ravel())[:: 20]  # drop 5% of the cells
    nearly.ravel()[flip] = False
    other = rng.random((days, inst)) < 0.1
    hit = np.where(base, rng.random((days, inst)) < 0.7, rng.random((days, inst)) < 0.2)
    usable = np.ones((days, inst), dtype=bool)
    usable_d = usable.copy()
    usable_d[280:] = False
    usable_h = usable & ~usable_d
    from miner.atoms import Atom

    atoms = [
        (Atom("a", "cross", "top"), pack(base)),
        (Atom("b", "cross", "top"), pack(nearly)),
        (Atom("c", "cross", "top"), pack(other)),
    ]
    res = beam_search(atoms, pack(usable_d), pack(usable_h), pack(hit), max_depth=1, min_support=10)
    kept = {res.finalists[k].rule.atoms for k in range(len(res.finalists))}
    assert res.suppressed == 1
    assert len(kept & {(0,), (1,)}) == 1
    assert (2,) in kept


def test_decay_states():
    from miner.decay import decay_state, reverify_checks
    from miner.search import WindowStats

    def ws(n, hits, base):
        from miner.stats import binomial_p_upper, wilson_lower

        rate = hits / n if n else 0.0
        return WindowStats(n, hits, rate, base, rate / base, wilson_lower(hits, n), binomial_p_upper(hits, n, base))

    assert decay_state(ws(9, 9, 0.2)) is None
    assert decay_state(ws(20, 4, 0.2)) == "broken"  # rate == base
    assert decay_state(ws(20, 6, 0.2)) == "weakening"  # beats base, lower bound does not
    assert decay_state(ws(400, 84, 0.2)) == "weakening"  # lift 1.05 < 1.1
    assert decay_state(ws(100, 60, 0.2)) == "holding"
    assert reverify_checks(ws(100, 60, 0.2)) == []
    assert any("n 10" in r for r in reverify_checks(ws(10, 9, 0.2)))


def test_score_after_counts_only_fresh_days_with_whole_horizon():
    from miner.atoms import Atom
    from miner.decay import score_after

    days, inst = 40, 60
    rng = np.random.default_rng(3)
    f = rng.standard_normal((days, inst))
    hit = rng.random((days, inst)) < 0.3
    out = outcomes_from_hits(hit)
    res = score_after({"f": f}, [Atom("f", "cross", "top")], out, direction="spike", threshold=0.05, after=20, horizon=5)
    assert res.occurrences and all(20 < o.day <= days - 1 - 5 for o in res.occurrences)
    assert all(o.window == "fresh" for o in res.occurrences)
    assert res.stats.n == len(res.occurrences)
