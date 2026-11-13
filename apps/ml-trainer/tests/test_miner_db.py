"""The miner against a migrated database (pattern brief §6, §11): a queued scan
over a synthetic factor store with one planted rule is claimed, mined and
written; the pattern's rule and evidence cannot be rewritten afterwards.

Needs ML_TEST_DATABASE_URL (see test_db.py). Skipped without it.
"""

from __future__ import annotations

import json
import os
import secrets
from datetime import date, timedelta

import numpy as np
import psycopg
import pytest

from miner.run import run_decay, run_queued

URL = os.environ.get("ML_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="ML_TEST_DATABASE_URL is not set")

INST, DAYS = 110, 420


@pytest.fixture(scope="module")
def worker_url():
    assert URL
    login = f"tm_pattest_{secrets.token_hex(4)}"
    password = secrets.token_hex(16)
    with psycopg.connect(URL, autocommit=True) as owner:
        owner.execute(f"create role {login} login password '{password}'")
        owner.execute(f"grant tm_app, tm_secrets to {login}")
    head, tail = URL.split("://", 1)
    host = tail.split("@", 1)[1]
    yield f"{head}://{login}:{password}@{host}"
    with psycopg.connect(URL, autocommit=True) as owner:
        owner.execute(f"drop owned by {login}")
        owner.execute(f"drop role {login}")


def weekdays(start: date, count: int) -> list[str]:
    out, d = [], start
    while len(out) < count:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


@pytest.fixture(scope="module")
def scan():
    """A user, 110 instruments, 420 days of snapshots with fA-top ∧ fB-top planted, one queued scan."""
    assert URL
    rng = np.random.default_rng(11)
    days = weekdays(date(2023, 1, 2), DAYS)
    tag = secrets.token_hex(3)
    with psycopg.connect(URL) as owner:
        user = owner.execute(
            "insert into \"user\" (name, email) values ('Pattern test', %s) returning id::text",
            (f"pattern-{tag}@example.com",),
        ).fetchone()[0]
        ids = [
            owner.execute(
                "insert into instrument (asset_class, symbol, venue, currency, display_name, tick_size) "
                "values ('stock', %s, 'NYSE', 'USD', %s, 0.01) returning id::text",
                (f"PT{k:03d}{tag.upper()}", f"PT{k:03d}"),
            ).fetchone()[0]
            for k in range(INST)
        ]
        fa = rng.standard_normal((DAYS, INST))
        fb = rng.standard_normal((DAYS, INST))
        fc = rng.standard_normal((DAYS, INST))
        planted = (fa >= np.quantile(fa, 0.8, axis=1, keepdims=True)) & (fb >= np.quantile(fb, 0.8, axis=1, keepdims=True))
        close_ret = rng.normal(0, 0.005, (DAYS, INST))
        high_rel = np.abs(close_ret) + 0.002
        low_rel = -np.abs(close_ret) - 0.002
        # Spikes: 80% of planted days see a +12% high two days later; elsewhere about 15%.
        for d in range(DAYS - 2):
            p = np.where(planted[d], 0.8, 0.0)
            high_rel[d + 2] = np.where(rng.random(INST) < p, 0.12, high_rel[d + 2])
        noise = rng.random((DAYS, INST)) < 0.035
        high_rel = np.where(noise, 0.12, high_rel)
        rows = []
        for d, day in enumerate(days):
            for i, iid in enumerate(ids):
                values = {"fA": float(fa[d, i]), "fB": float(fb[d, i]), "fC": float(fc[d, i])}
                rows.append((day, iid, json.dumps(values), float(close_ret[d, i]) if d else None,
                             float(high_rel[d, i]) if d else None, float(low_rel[d, i]) if d else None))
        with owner.cursor() as cur:
            cur.executemany(
                "insert into factor_snapshot (as_of, instrument_id, values, close_ret, high_rel, low_rel, catalogue_version) "
                "values (%s, %s, %s, %s, %s, %s, 1)",
                rows,
            )
            for f in ("_rows", "fA", "fB", "fC"):
                cur.executemany(
                    "insert into factor_coverage (factor, as_of, known) values (%s, %s, %s) "
                    "on conflict (factor, as_of) do update set known = factor_coverage.known + excluded.known",
                    [(f, day, INST) for day in days],
                )
        config = {
            "universe": {"kind": "group", "id": "test"},
            "memberIds": ids,
            "outcome": {"direction": "spike", "pct": 8, "horizon": 5},
            "categories": ["price"],
            "factors": [
                {"id": "fA", "category": "price", "modes": ["cross"]},
                {"id": "fB", "category": "price", "modes": ["cross"]},
                {"id": "fC", "category": "price", "modes": ["cross"]},
            ],
            "maxDepth": 3,
            "minSupport": 40,
            "range": {"to": days[330]},
            "split": {"discovery": 0.7},
        }
        sid = owner.execute(
            "insert into pattern_scan (user_id, config, summary) values (%s, %s, 'test scan') returning id::text",
            (user, json.dumps(config)),
        ).fetchone()[0]
        owner.commit()
    yield sid, user, days
    with psycopg.connect(URL) as owner:
        owner.execute("delete from \"user\" where id = %s", (user,))
        owner.execute("delete from factor_snapshot where instrument_id = any(%s::uuid[])", (ids,))
        owner.execute("delete from factor_coverage where factor in ('fA', 'fB', 'fC', '_rows')")
        owner.execute("delete from instrument where id = any(%s::uuid[])", (ids,))
        owner.commit()


def test_a_queued_scan_is_mined_and_written(worker_url, scan):
    sid, user, days = scan
    with psycopg.connect(worker_url) as conn:
        done = run_queued(conn, "miner test")
    assert [d["scan"] for d in done] == [sid]
    with psycopg.connect(URL) as owner:
        status, tested, finalists, verified, effective = owner.execute(
            "select status, candidates_tested, finalists, verified, effective from pattern_scan where id = %s", (sid,)
        ).fetchone()
        assert status == "done"
        assert tested >= 6 and finalists >= 1 and verified >= 1
        # Own lookback rows before the range are loaded but not scanned: the range starts at coverage.
        assert effective["from"] == days[0]
        assert effective["discoveryEnd"] < effective["holdoutStart"]
        rows = owner.execute(
            "select id::text, rule, stats, status from pattern where scan_id = %s order by rank", (sid,)
        ).fetchall()
        best = next(r for r in rows if r[3] == "verified")
        factors = {(a["factor"], a["bucket"]) for a in best[1]}
        assert {("fA", "top"), ("fB", "top")} <= factors
        hold = best[2]["holdout"]
        assert hold["rate"] > 0.6 and hold["baseRate"] < 0.4
        occ = owner.execute(
            "select \"window\", count(*), sum(hit::int) from pattern_occurrence where pattern_id = %s group by 1",
            (best[0],),
        ).fetchall()
        counts = {w: (n, h) for w, n, h in occ}
        assert counts["holdout"] == (hold["n"], hold["hits"])
        assert counts["discovery"][0] == best[2]["discovery"]["n"]
    # Nothing left to do.
    with psycopg.connect(worker_url) as conn:
        assert run_queued(conn, "miner test") == []


def test_pattern_evidence_is_never_rewritten(worker_url, scan):
    sid, _, _ = scan
    with psycopg.connect(worker_url) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute("update pattern set stats = '{}' where scan_id = %s", (sid,))
    with psycopg.connect(worker_url) as conn:
        # The state fields decay monitoring writes are allowed.
        conn.execute("update pattern set decay_state = 'holding' where scan_id = %s", (sid,))
        conn.rollback()


def test_decay_scores_fresh_days_and_reverify_runs_on_request(worker_url, scan):
    sid, _, days = scan
    with psycopg.connect(worker_url) as conn:
        scored = run_decay(conn, "miner test", today=days[-1])
    with psycopg.connect(URL) as owner:
        pid, state, stats, last_scored = owner.execute(
            "select id::text, decay_state, decay_stats, last_scored::text from pattern "
            "where scan_id = %s and status = 'verified' order by rank limit 1",
            (sid,),
        ).fetchone()
        assert pid in {s["pattern"] for s in scored}
        assert last_scored == days[-1]
        fresh = stats["fresh"]
        # Fresh = strictly after the holdout ended (day 330), with the whole horizon in the data.
        assert stats["freshFrom"] == days[331]
        assert fresh["n"] >= 10 and fresh["rate"] > 0.6
        assert state == "holding"
        n_fresh, first = owner.execute(
            "select count(*), min(as_of)::text from pattern_occurrence where pattern_id = %s and \"window\" = 'fresh'",
            (pid,),
        ).fetchone()
        assert n_fresh == fresh["n"] and first > days[330]
    # Scored this week: not due again, so a second run does nothing ...
    with psycopg.connect(worker_url) as conn:
        assert run_decay(conn, "miner test", today=days[-1]) == []
        # ... until a re-verify is requested (brief §10).
        conn.execute(
            "update pattern set decay_stats = decay_stats || jsonb_build_object('reverifyRequestedAt', now()) where id = %s",
            (pid,),
        )
        conn.commit()
        again = run_decay(conn, "miner test", today=days[-1])
    assert [a["pattern"] for a in again] == [pid] and again[0]["reverified"] is True
    with psycopg.connect(URL) as owner:
        stats, n_fresh_after = owner.execute(
            "select decay_stats, (select count(*) from pattern_occurrence where pattern_id = %s and \"window\" = 'fresh') "
            "from pattern where id = %s",
            (pid, pid),
        ).fetchone()
        assert "reverifyRequestedAt" not in stats
        rv = stats["reverify"]
        assert rv["verified"] and rv["failedChecks"] == []
        # One fresh holdout: everything after the discovery window.
        effective = owner.execute("select effective from pattern_scan where id = %s", (sid,)).fetchone()[0]
        assert rv["from"] == effective["holdoutStart"]
        assert rv["stats"]["n"] > stats["fresh"]["n"]
        assert n_fresh_after == stats["fresh"]["n"]
