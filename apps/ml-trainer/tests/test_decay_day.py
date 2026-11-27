"""The decay job's day is the UTC day, the one the cloud's due list uses (N351)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import miner.run as run


class _Evening:
    """7:30 PM in New York on 2026-11-26 is already 2026-11-27 in UTC."""

    @staticmethod
    def now(tz=None):
        at = datetime(2026, 11, 27, 0, 30, tzinfo=UTC)
        return at.astimezone(tz) if tz else at.astimezone(timezone(timedelta(hours=-5))).replace(tzinfo=None)


def test_run_decay_asks_for_patterns_due_on_the_utc_day(monkeypatch):
    seen: list[str] = []
    monkeypatch.setattr(run, "datetime", _Evening)
    monkeypatch.setattr(run, "last_snapshot_day", lambda conn: "2026-11-26")
    monkeypatch.setattr(run, "_due_patterns", lambda conn, today: seen.append(today) or [])
    assert run.run_decay(object(), "test") == []  # type: ignore[arg-type]
    assert seen == ["2026-11-27"]
