"""Point-in-time universe membership in the miner (N324, ADR 0112)."""

from __future__ import annotations

import numpy as np

from miner.atoms import build_atoms, cross_quintiles
from miner.labels import Outcomes
from miner.membership import member_mask, only_members
from miner.run import ScanConfig

DAYS = ["2020-12-17", "2020-12-18", "2020-12-21", "2020-12-22"]


def test_mask_follows_each_span():
    mask = member_mask(DAYS, ["tsla", "aiv", "aapl"], {
        "tsla": [["2020-12-21", None]],
        "aiv": [["2010-01-04", "2020-12-21"]],
        "aapl": [["1996-01-02", None]],
    })
    assert mask is not None
    assert mask[:, 0].tolist() == [False, False, True, True]
    assert mask[:, 1].tolist() == [True, True, False, False]
    assert mask[:, 2].all()


def test_no_spans_is_todays_list():
    assert member_mask(DAYS, ["a"], None) is None
    assert member_mask(DAYS, ["a"], {}) is None


def test_non_member_days_are_never_occurrences():
    member = np.array([[True, False], [True, True]])
    o = Outcomes(np.full((2, 2), 0.1), np.full((2, 2), -0.1), np.full((2, 2), 0.05))
    known = only_members(o, member).known()
    assert known.tolist() == [[True, False], [True, True]]
    assert only_members(o, None) is o


def test_cross_section_ranks_only_that_days_members():
    rng = np.random.default_rng(1)
    grid = rng.standard_normal((3, 60))
    grid[:, 0] = 100.0  # the largest value, but not a member on day 0
    member = np.ones((3, 60), dtype=bool)
    member[0, 0] = False
    atoms = dict((a.bucket, g) for a, g in build_atoms({"f": grid}, {"f": ["cross"]}, member))
    assert not atoms["top"][0, 0]
    assert atoms["top"][1, 0]
    top_all, _ = cross_quintiles(grid)
    assert top_all[0, 0]


def test_config_reads_member_periods():
    raw = {
        "memberIds": ["a"],
        "outcome": {"direction": "spike", "pct": 5, "horizon": 5},
        "categories": ["price"],
        "factors": [],
        "memberPeriods": {"a": [["2020-01-02", None]]},
    }
    assert ScanConfig.parse(raw).member_periods == {"a": [["2020-01-02", None]]}
    del raw["memberPeriods"]
    assert ScanConfig.parse(raw).member_periods is None
