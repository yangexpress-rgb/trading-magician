"""Synthetic datasets for the protocol tests: month-end dates, labels a month on."""

from __future__ import annotations

import calendar
import random
from datetime import date, timedelta

from trainer.protocol import Dataset, Label, Row

FEATURES = [
    "mom_12_1", "mom_6_1", "mom_3_1", "rev_1m", "vol_60", "rsi_14",
    "dist_high_252", "pe", "earnings_yield", "dividend_yield", "sue",
]


def month_ends(start_year: int, months: int) -> list[str]:
    out = []
    y, m = start_year, 1
    for _ in range(months):
        d = date(y, m, calendar.monthrange(y, m)[1])
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        out.append(d.isoformat())
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def label_end(dates: list[str], t: str) -> str:
    """21 trading days on: just after the next month end, as in real calendars."""
    i = dates.index(t)
    nxt = dates[i + 1] if i + 1 < len(dates) else (date.fromisoformat(t) + timedelta(days=31)).isoformat()
    return (date.fromisoformat(nxt) + timedelta(days=1)).isoformat()


def dataset(months: int = 30, members: int = 40, seed: int = 7, *, known_answer: bool = False) -> Dataset:
    rng = random.Random(seed)
    dates = month_ends(2019, months)
    ids = [f"00000000-0000-4000-8000-{i:012x}" for i in range(1, members + 1)]
    snapshots: dict[str, list[Row]] = {}
    labels: dict[str, dict[str, Label]] = {}
    for t in dates:
        rows = []
        lab = {}
        for iid in ids:
            if known_answer:
                f = {n: 0.0 for n in FEATURES}
                f["mom_12_1"] = rng.gauss(0, 1)
                ret = 0.02 * f["mom_12_1"] + 0.001
            else:
                f = {n: rng.gauss(0, 1) for n in FEATURES}
                ret = 0.01 * f["mom_12_1"] - 0.005 * f["vol_60"] + rng.gauss(0, 0.05)
            rows.append(Row(iid, f))
            lab[iid] = Label(label_end(dates, t), ret)
        snapshots[t] = rows
        labels[t] = lab
    return Dataset(
        feature_names=FEATURES,
        snapshots=snapshots,
        labels=labels,
        availability={n: dates[0] for n in FEATURES},
    )
