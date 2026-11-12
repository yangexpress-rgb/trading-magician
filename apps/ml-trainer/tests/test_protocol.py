"""The §7 protocol and the §12 fixtures on the trainer's side (checks 1, 2 and 3)."""

from __future__ import annotations

import dataclasses
import json

import pytest

from trainer import protocol
from trainer.protocol import Dataset, Label, NotTrainable, Row

from .synthetic import FEATURES, dataset


def predictions(data: Dataset, dates: list[str]) -> str:
    """Every served date's run and scores, serialised exactly (repr of floats)."""
    out = []
    for d in dates:
        try:
            fit = protocol.fit_for(data, d)
        except NotTrainable:
            continue
        out.append(json.dumps(dataclasses.asdict(fit), sort_keys=True))
    return "\n".join(out)


def test_waits_for_18_cross_sections_with_realised_labels() -> None:
    data = dataset(months=30)
    dates = sorted(data.snapshots)
    served = [d for d in dates if _serves(data, d)]
    # The 18th labelled month realises just after the 19th month end: first served date is the 20th.
    assert served[0] == dates[19]
    fit = protocol.fit_for(data, dates[19])
    assert fit.cross_sections == 18
    with pytest.raises(NotTrainable, match="18 needed"):
        protocol.fit_for(data, dates[18])


def _serves(data: Dataset, d: str) -> bool:
    try:
        protocol.fit_for(data, d)
        return True
    except NotTrainable:
        return False


def test_embargo_fixture_excludes_a_label_window_crossing_the_date() -> None:
    """§12 check 2: the month before T has a label ending after T; it is not trained on."""
    data = dataset(months=30)
    dates = sorted(data.snapshots)
    T = dates[25]
    fit = protocol.fit_for(data, T)
    prev = dates[24]
    assert data.labels[prev][next(iter(data.labels[prev]))].label_end > T
    assert fit.training_end == dates[23]
    assert fit.max_label_end < T
    # A window that ends exactly on T touches it, and is excluded too.
    touching = {k: Label(T, l.forward_return) for k, l in data.labels[dates[23]].items()}
    data2 = dataclasses.replace(data, labels={**data.labels, dates[23]: touching})
    fit2 = protocol.fit_for(data2, T)
    assert fit2.training_end == dates[22]
    assert fit2.max_label_end < T


def test_known_answer_fixture_ranks_in_label_order() -> None:
    """§12 check 3: label = positive linear function of mom_12_1 alone; IC is 1."""
    data = dataset(months=24, known_answer=True)
    dates = sorted(data.snapshots)
    first = next(d for d in dates if _serves(data, d))
    fit = protocol.fit_for(data, first)
    ev = protocol.evaluate(fit.scores, len(data.snapshots[first]), data.labels[first])
    assert ev.ic == pytest.approx(1.0)
    assert fit.coefficients["mom_12_1"] > 0
    order_by_score = sorted(fit.scores, key=fit.scores.__getitem__)
    labels = protocol.demeaned_labels(data.labels[first])
    assert order_by_score == sorted(labels, key=labels.__getitem__)


def test_no_leakage_fixture_predictions_up_to_T_are_byte_identical() -> None:
    """§12 check 1 (trainer half): change everything known only after T; dates ≤ T don't move."""
    data = dataset(months=36)
    dates = sorted(data.snapshots)
    T = dates[28]
    before = predictions(data, [d for d in dates if d <= T])
    mutated_snaps = {
        t: (
            [Row(r.instrument_id, {k: (v * 2 + 1 if v is not None else None) for k, v in r.features.items()}) for r in rows]
            if t > T
            else rows
        )
        for t, rows in data.snapshots.items()
    }
    mutated_labels = {
        t: {k: (Label(l.label_end, l.forward_return * -3 + 0.1) if l.label_end > T else l) for k, l in lab.items()}
        for t, lab in data.labels.items()
    }
    mutated = dataclasses.replace(data, snapshots=mutated_snaps, labels=mutated_labels)
    after = predictions(mutated, [d for d in dates if d <= T])
    assert before and after == before
    # And the mutation is real: a later date's predictions change.
    later = [d for d in dates if d > T][2:4]
    assert predictions(mutated, later) != predictions(data, later)


def test_a_member_with_a_null_feature_gets_no_prediction_and_trains_on_nothing() -> None:
    data = dataset(months=30)
    dates = sorted(data.snapshots)
    T = dates[25]
    rows = list(data.snapshots[T])
    gone = rows[0].instrument_id
    rows[0] = Row(gone, {**rows[0].features, "pe": None})
    data = dataclasses.replace(data, snapshots={**data.snapshots, T: rows})
    fit = protocol.fit_for(data, T)
    assert gone not in fit.scores
    assert len(fit.scores) == len(rows) - 1


def test_refuses_a_feature_never_available() -> None:
    data = dataset(months=30)
    data = dataclasses.replace(data, availability={**data.availability, "sue": None})
    with pytest.raises(NotTrainable, match="sue"):
        protocol.fit_for(data, sorted(data.snapshots)[25])


def test_training_starts_at_the_binding_feature() -> None:
    data = dataset(months=40)
    dates = sorted(data.snapshots)
    data = dataclasses.replace(data, availability={**data.availability, "pe": dates[5]})
    fit = protocol.fit_for(data, dates[30])
    assert fit.training_start == dates[5]


def test_alpha_ties_go_to_the_larger_alpha() -> None:
    data = dataset(months=30, known_answer=True)
    dates = sorted(data.snapshots)
    alpha, scores, val = protocol.choose_alpha(data, dates[:20])
    # Every alpha ranks the known answer perfectly: a tie, so the largest wins.
    assert all(v == pytest.approx(1.0) for v in scores.values())
    assert alpha == 100.0
    assert val == dates[14:20]


def test_spearman_and_decile_spread() -> None:
    assert protocol.spearman([1, 2, 3, 4], [10, 20, 30, 40]) == pytest.approx(1.0)
    assert protocol.spearman([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)
    assert protocol.spearman([1, 1, 2], [1, 2, 3]) == pytest.approx(0.8660254, rel=1e-6)
    scores = {f"m{i}": float(i) for i in range(20)}
    labels = {f"m{i}": Label("2020-02-03", i / 100) for i in range(20)}
    ev = protocol.evaluate(scores, 25, labels)
    assert ev.ic == pytest.approx(1.0)
    assert ev.decile_spread == pytest.approx((18.5 - 0.5) / 100)
    assert (ev.universe_size, ev.predicted, ev.labelled) == (25, 20, 20)


def test_features_list_matches_the_brief() -> None:
    assert FEATURES == [
        "mom_12_1", "mom_6_1", "mom_3_1", "rev_1m", "vol_60", "rsi_14",
        "dist_high_252", "pe", "earnings_yield", "dividend_yield", "sue",
    ]
