"""The trainer against a migrated database (ML brief v1 §9): the backfill writes
runs, predictions, evaluations and the report; a second pass rewrites nothing.

Needs ML_TEST_DATABASE_URL: the owner's connection to a database migrated by
`pnpm --filter @tm/db db:migrate`. Skipped without it.
"""

from __future__ import annotations

import json
import os
import secrets

import psycopg
import pytest

from trainer import __main__ as cli
from trainer import db

from .synthetic import FEATURES, dataset

URL = os.environ.get("ML_TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="ML_TEST_DATABASE_URL is not set")


@pytest.fixture(scope="module")
def worker_url():
    """A throwaway login with the worker's roles (tm_app, tm_secrets), as on Railway."""
    assert URL
    login = f"tm_mltest_{secrets.token_hex(4)}"
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


@pytest.fixture(scope="module")
def model_id():
    """A test model with 30 months of snapshots and labels for 40 members."""
    assert URL
    data = dataset(months=30)
    key = f"py-test-{secrets.token_hex(3)}"
    with psycopg.connect(URL) as owner:
        ids = {}
        for t, rows in data.snapshots.items():
            for r in rows:
                if r.instrument_id not in ids:
                    sym = f"PY{len(ids):03d}{secrets.token_hex(2).upper()}"
                    ids[r.instrument_id] = owner.execute(
                        "insert into instrument (asset_class, symbol, venue, currency, display_name, tick_size) "
                        "values ('stock', %s, 'NYSE', 'USD', %s, 0.01) returning id::text",
                        (sym, sym),
                    ).fetchone()[0]
        mid = owner.execute(
            "insert into ml_model (model_key, name, universe, feature_set, feature_set_version, label, algorithm, "
            "snapshots_from, availability) values (%s, %s, 'test', %s, 1, '{}', 'ridge', %s, %s) returning id::text",
            (key, key, json.dumps(FEATURES), min(data.snapshots), json.dumps(dict(data.availability))),
        ).fetchone()[0]
        for t, rows in data.snapshots.items():
            for r in rows:
                owner.execute(
                    "insert into ml_feature_snapshot (model_id, instrument_id, as_of, features, raw) values (%s, %s, %s, %s, %s)",
                    (mid, ids[r.instrument_id], t, json.dumps(dict(r.features)), json.dumps(dict(r.features))),
                )
            for iid, l in data.labels[t].items():
                owner.execute(
                    "insert into ml_label (model_id, instrument_id, as_of, label_end, forward_return) values (%s, %s, %s, %s, %s)",
                    (mid, ids[iid], t, l.label_end, l.forward_return),
                )
        owner.commit()
    return key, mid


def test_backfill_writes_runs_predictions_evaluations_and_report(worker_url, model_id, monkeypatch):
    key, mid = model_id
    with db.connect(worker_url) as conn:
        first = cli.catch_up(conn, model_keys=[key], until_year=2020)
        second = cli.catch_up(conn, model_keys=[key])
    # 30 month ends from Jan 2019; the 20th (Aug 2020) is the first with 18 labelled sections.
    assert first[key]["written"] == 5  # Aug–Dec 2020
    assert second[key]["written"] == 6  # Jan–Jun 2021, resumed
    with psycopg.connect(URL) as owner:
        runs = owner.execute(
            "select run_no, prediction_date::text, max_label_end::text, cross_sections, "
            "(select count(*) from ml_prediction p where p.model_run_id = r.id) "
            "from ml_model_run r where model_id = %s order by run_no",
            (mid,),
        ).fetchall()
        assert [r[0] for r in runs] == list(range(1, 12))
        assert all(r[2] < r[1] for r in runs)  # the embargo on every run row
        assert all(r[4] == 40 for r in runs)
        assert runs[0][3] == 18
        evaluated = owner.execute(
            "select count(*), avg(ic) from ml_evaluation e join ml_model_run r on r.id = e.model_run_id where r.model_id = %s",
            (mid,),
        ).fetchone()
        assert evaluated[0] == 11
        assert evaluated[1] > 0  # the synthetic label does depend on mom_12_1
        report = owner.execute(
            "select markdown, summary from ml_report where model_id = %s order by created_at desc limit 1", (mid,)
        ).fetchone()
        assert "Mean monthly rank IC" in report[0]
        assert report[1]["predictionDates"] == 11
    # A third pass writes nothing: existing predictions are never rewritten.
    with db.connect(worker_url) as conn:
        third = cli.catch_up(conn, model_keys=[key])
    assert third[key]["written"] == 0 and third[key]["evaluated"] == 0


def test_predictions_cannot_be_edited_by_the_trainer_login(worker_url, model_id):
    _, mid = model_id
    with psycopg.connect(worker_url) as conn:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            conn.execute(
                "update ml_prediction set score = 0 where model_run_id in "
                "(select id from ml_model_run where model_id = %s)",
                (mid,),
            )


def test_switched_off_by_default(monkeypatch, capsys):
    monkeypatch.delenv("ML_TRAINER_ENABLED", raising=False)
    assert cli.main([]) == 0
    assert "switched off" in capsys.readouterr().out
