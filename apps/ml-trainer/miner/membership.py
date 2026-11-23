"""Point-in-time universe membership (N324, ADR 0112).

A scan of the S&P 500 stores each member's spans in its config (`memberPeriods`,
`[from, to]` with `to` exclusive and null while still a member). A day counts for
an instrument only while it was a member: outcomes outside are unknown, and the
cross-section ranks only that day's members. Without spans every member counts on
every day (today's list), as before.
"""

from __future__ import annotations

import numpy as np

from .labels import Outcomes


def member_mask(days: list[str], inst: list[str], periods: dict[str, list[list[str | None]]] | None) -> np.ndarray | None:
    """(day, instrument) booleans: whether the instrument was a member that day; None without spans."""
    if not periods:
        return None
    mask = np.zeros((len(days), len(inst)), dtype=bool)
    day_arr = np.array(days, dtype=object)
    for i, iid in enumerate(inst):
        for span in periods.get(iid, []):
            start, end = span[0], span[1]
            inside = day_arr >= start
            if end is not None:
                inside &= day_arr < end
            mask[:, i] |= inside.astype(bool)
    return mask


def only_members(outcomes: Outcomes, member: np.ndarray | None) -> Outcomes:
    """Outcomes with every non-member day unknown, so it is never an occurrence or a base-rate cell."""
    if member is None:
        return outcomes
    return Outcomes(
        runup=np.where(member, outcomes.runup, np.nan),
        drawdown=np.where(member, outcomes.drawdown, np.nan),
        forward=np.where(member, outcomes.forward, np.nan),
    )
