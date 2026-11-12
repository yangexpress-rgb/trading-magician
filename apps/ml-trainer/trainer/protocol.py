"""The training protocol of ML brief v1 §7, as pure functions.

Everything here is deterministic: the same snapshots and labels give
byte-identical predictions. Nothing here touches the database.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

import numpy as np
from sklearn.linear_model import Ridge

#: Ridge alphas tried at every refit (§7).
ALPHA_GRID: tuple[float, ...] = (0.1, 1.0, 10.0, 100.0)
#: Cross-sections in the validation tail of the alpha search (§7).
VALIDATION_SECTIONS = 6
#: Fewest monthly cross-sections a series trains on before its first prediction (§7).
MIN_CROSS_SECTIONS = 18


@dataclass(frozen=True)
class Row:
    """One member's snapshot on one prediction date."""

    instrument_id: str
    features: Mapping[str, float | None]


@dataclass(frozen=True)
class Label:
    """A member's realised forward return from a prediction date (O152)."""

    label_end: str
    forward_return: float


@dataclass
class Dataset:
    """What the trainer reads for one model series."""

    feature_names: Sequence[str]
    #: Prediction date (YYYY-MM-DD) -> that date's snapshot rows.
    snapshots: Mapping[str, Sequence[Row]]
    #: Prediction date -> instrument id -> realised label.
    labels: Mapping[str, Mapping[str, Label]]
    #: Feature -> earliest date >= 90% of members had it (§5), or None.
    availability: Mapping[str, str | None] = field(default_factory=dict)


class NotTrainable(Exception):
    """A prediction date that can't be served yet, and why (never trained on less)."""


@dataclass
class Fit:
    """One refit for one prediction date: what the run row and predictions store."""

    prediction_date: str
    training_start: str
    training_end: str
    max_label_end: str
    rows_trained: int
    cross_sections: int
    alpha: float
    cv_ic: dict[str, float | None]
    validation_dates: list[str]
    coefficients: dict[str, float]
    intercept: float
    #: instrument id -> score, for members with every feature.
    scores: dict[str, float]


def complete(row: Row, names: Sequence[str]) -> bool:
    """Every feature has a value: only such rows train or get a prediction (§6)."""
    return all(row.features.get(n) is not None for n in names)


def median(values: Sequence[float]) -> float:
    return float(np.median(np.asarray(values, dtype=float)))


def demeaned_labels(labels: Mapping[str, Label]) -> dict[str, float]:
    """The §7 label: forward return minus the universe median of the same, that date."""
    if not labels:
        return {}
    m = median([l.forward_return for l in labels.values()])
    return {k: l.forward_return - m for k, l in labels.items()}


def ranks(values: Sequence[float]) -> np.ndarray:
    """Ranks from 1, ties sharing their average rank."""
    a = np.asarray(values, dtype=float)
    order = np.argsort(a, kind="mergesort")
    r = np.empty(len(a), dtype=float)
    i = 0
    while i < len(a):
        j = i
        while j + 1 < len(a) and a[order[j + 1]] == a[order[i]]:
            j += 1
        r[order[i : j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    return r


def spearman(x: Sequence[float], y: Sequence[float]) -> float | None:
    """Spearman rank correlation, or None with fewer than 3 pairs or no spread."""
    if len(x) < 3 or len(x) != len(y):
        return None
    rx, ry = ranks(x), ranks(y)
    sx, sy = rx.std(), ry.std()
    if sx == 0 or sy == 0:
        return None
    return float(((rx - rx.mean()) * (ry - ry.mean())).mean() / (sx * sy))


def training_start(data: Dataset) -> str:
    """The first date every feature was available (§5); refuses a feature never available."""
    missing = [n for n in data.feature_names if not data.availability.get(n)]
    if missing:
        raise NotTrainable(f"features never available for 90% of members: {', '.join(missing)}")
    return max(str(data.availability[n]) for n in data.feature_names)


def eligible_sections(data: Dataset, prediction_date: str, start: str) -> list[str]:
    """Snapshot dates whose labels had fully realised before the prediction date (the embargo, §7).

    A date t is used only when t < T and its label window (t + 21 trading days)
    ended before T: a window that touches or crosses T is excluded.
    """
    out = []
    for t in sorted(data.snapshots):
        if t < start or t >= prediction_date:
            continue
        labels = data.labels.get(t, {})
        if not labels:
            continue
        if max(l.label_end for l in labels.values()) >= prediction_date:
            continue
        out.append(t)
    return out


def _matrix(
    data: Dataset, dates: Sequence[str]
) -> tuple[np.ndarray, np.ndarray, list[str], list[str]]:
    names = list(data.feature_names)
    xs: list[list[float]] = []
    ys: list[float] = []
    row_dates: list[str] = []
    ends: list[str] = []
    for t in dates:
        labels = data.labels.get(t, {})
        y = demeaned_labels(labels)
        for row in sorted(data.snapshots[t], key=lambda r: r.instrument_id):
            if not complete(row, names) or row.instrument_id not in y:
                continue
            xs.append([float(row.features[n]) for n in names])  # type: ignore[arg-type]
            ys.append(y[row.instrument_id])
            row_dates.append(t)
            ends.append(labels[row.instrument_id].label_end)
    x = np.asarray(xs, dtype=float).reshape(len(xs), len(names))
    return x, np.asarray(ys, dtype=float), row_dates, ends


def _ridge(alpha: float) -> Ridge:
    # Features are already z-scored per date by the app (§6): no re-standardising here.
    return Ridge(alpha=alpha, fit_intercept=True, solver="cholesky")


def choose_alpha(data: Dataset, sections: Sequence[str]) -> tuple[float, dict[str, float | None], list[str]]:
    """Alpha by time-series CV inside the training window (§7).

    The last six eligible cross-sections validate, the earlier ones fit; the
    alpha with the best mean validation IC wins, ties going to the larger alpha.
    """
    fit_dates = list(sections[:-VALIDATION_SECTIONS])
    val_dates = list(sections[-VALIDATION_SECTIONS:])
    x, y, _, _ = _matrix(data, fit_dates)
    scores: dict[str, float | None] = {}
    best_alpha = ALPHA_GRID[-1]
    best_ic: float | None = None
    for alpha in ALPHA_GRID:
        if len(y) == 0:
            scores[repr(alpha)] = None
            continue
        model = _ridge(alpha).fit(x, y)
        ics = []
        for t in val_dates:
            vx, vy, _, _ = _matrix(data, [t])
            if len(vy) < 3:
                continue
            ic = spearman(model.predict(vx).tolist(), vy.tolist())
            if ic is not None:
                ics.append(ic)
        mean = float(np.mean(ics)) if ics else None
        scores[repr(alpha)] = mean
        if mean is not None and (best_ic is None or mean >= best_ic):
            best_ic, best_alpha = mean, alpha
    return best_alpha, scores, val_dates


def fit_for(data: Dataset, prediction_date: str) -> Fit:
    """Refit for one prediction date and score its members (§7)."""
    names = list(data.feature_names)
    start = training_start(data)
    sections = eligible_sections(data, prediction_date, start)
    x, y, row_dates, ends = _matrix(data, sections)
    used = sorted(set(row_dates))
    if len(used) < MIN_CROSS_SECTIONS:
        raise NotTrainable(
            f"{len(used)} cross-sections with realised labels before {prediction_date}; "
            f"{MIN_CROSS_SECTIONS} needed"
        )
    max_end = max(ends)
    # The embargo, asserted as well as recorded (§7, §12 check 2).
    assert max_end < prediction_date, "a training label ends on or after the prediction date"
    alpha, cv_ic, val_dates = choose_alpha(data, used)
    model = _ridge(alpha).fit(x, y)
    targets = sorted(
        (r for r in data.snapshots.get(prediction_date, []) if complete(r, names)),
        key=lambda r: r.instrument_id,
    )
    scores: dict[str, float] = {}
    if targets:
        tx = np.asarray([[float(r.features[n]) for n in names] for r in targets], dtype=float)  # type: ignore[arg-type]
        for r, s in zip(targets, model.predict(tx).tolist()):
            scores[r.instrument_id] = float(s)
    return Fit(
        prediction_date=prediction_date,
        training_start=used[0],
        training_end=used[-1],
        max_label_end=max_end,
        rows_trained=int(len(y)),
        cross_sections=len(used),
        alpha=alpha,
        cv_ic=cv_ic,
        validation_dates=val_dates,
        coefficients={n: float(c) for n, c in zip(names, model.coef_.tolist())},
        intercept=float(model.intercept_),
        scores=scores,
    )


@dataclass
class Evaluation:
    """How one date's scores did once its labels realised (§4 ml_evaluation)."""

    ic: float | None
    universe_size: int
    predicted: int
    labelled: int
    decile_spread: float | None


def evaluate(
    scores: Mapping[str, float], snapshot_size: int, labels: Mapping[str, Label]
) -> Evaluation:
    """Spearman IC of scores vs realised labels, and top-minus-bottom decile label spread."""
    y = demeaned_labels(labels)
    pairs = sorted((s, y[k], k) for k, s in scores.items() if k in y)
    ic = spearman([p[0] for p in pairs], [p[1] for p in pairs])
    spread = None
    n = len(pairs)
    if n >= 10:
        d = n // 10
        bottom = [p[1] for p in pairs[:d]]
        top = [p[1] for p in pairs[-d:]]
        spread = float(np.mean(top) - np.mean(bottom))
    return Evaluation(
        ic=ic,
        universe_size=snapshot_size,
        predicted=len(scores),
        labelled=n,
        decile_spread=spread,
    )
