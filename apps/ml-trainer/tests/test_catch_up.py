"""Every pending date is tried on every run: an unservable early month never blocks a later one."""

from __future__ import annotations

import dataclasses

from trainer import __main__ as cli
from trainer import protocol

from .synthetic import dataset


def _try_all(data):
    written, skipped = [], {}
    for d in sorted(data.snapshots):
        try:
            protocol.fit_for(data, d)
            written.append(d)
        except protocol.NotTrainable as e:
            skipped[d] = str(e)
    return written, skipped


def test_late_binding_feature_skips_early_months_without_blocking_later_ones() -> None:
    # As on staging: snapshots from the first month, one feature only available 10 months in.
    data = dataset(months=40)
    dates = sorted(data.snapshots)
    data = dataclasses.replace(data, availability={**data.availability, "pe": dates[10]})
    written, skipped = _try_all(data)
    # 18 labelled sections from dates[10] realise just after dates[28]: dates[29] is the first served.
    assert written == dates[29:]
    assert sorted(skipped) == dates[:29]
    summary = cli.skip_summary(skipped)
    assert summary["notTrainable"] == 29
    assert summary["notTrainableRange"] == [dates[0], dates[28]]
    assert summary["notTrainableByReason"] == {
        "fewer than 18 cross-sections with realised labels since the training start": 29
    }
    latest = summary["latestNotTrainable"]
    assert latest["date"] == dates[28] and latest["reason"].startswith("17 cross-sections")


def test_skip_summary_keeps_other_reasons_apart() -> None:
    summary = cli.skip_summary(
        {"2020-01-31": "features never available for 90% of members: sue", "2020-02-28": "0 cross-sections with realised labels before 2020-02-28; 18 needed"}
    )
    assert summary["notTrainableByReason"] == {
        "features never available for 90% of members: sue": 1,
        "fewer than 18 cross-sections with realised labels since the training start": 1,
    }
    assert cli.skip_summary({})["latestNotTrainable"] is None
