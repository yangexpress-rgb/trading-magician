"""The trainer with a separate Research Store (ADR 0115): training data,
evaluations and the report are read and written there; runs and predictions
go to Core; the predicted dates are frozen on the Research side.

Needs ML_TEST_DATABASE_URL (a migrated Core) and ML_TEST_RESEARCH_URL (a
database with the Research Store's migrations). Skipped without them.
"""

from __future__ import annotations

import json
import os
import secrets
import uuid

import psycopg
import pytest

from trainer import __main__ as cli
from trainer import db

from .synthetic import FEATURES, dataset

CORE = os.environ.get("ML_TEST_DATABASE_URL")
RESEARCH = os.environ.get("ML_TEST_RESEARCH_URL")
pytestmark = pytest.mark.skipif(not (CORE and RESEARCH), reason="two test databases are not set")


def test_two_stores():
    assert CORE and RESEARCH
    data = dataset(months=24)
    key = f"py-two-{secrets.token_hex(3)}"
    with psycopg.connect(CORE) as core, psycopg.connect(RESEARCH) as research:
        ids: dict[str, str] = {}
        for rows in data.snapshots.values():
            for r in rows:
                if r.instrument_id not in ids:
                    sym = f"PT{len(ids):03d}{secrets.token_hex(2).upper()}"
                    ids[r.instrument_id] = core.execute(
                        "insert into instrument (asset_class, symbol, venue, currency, display_name, tick_size) "
                        "values ('stock', %s, 'NYSE', 'USD', %s, 0.01) returning id::text",
                        (sym, sym),
                    ).fetchone()[0]
        mid = core.execute(
            "insert into ml_model (model_key, name, universe, feature_set, feature_set_version, label, algorithm, "
            "snapshots_from, availability) values (%s, %s, 'test', %s, 1, '{}', 'ridge', %s, %s) returning id::text",
            (key, key, json.dumps(FEATURES), min(data.snapshots), json.dumps(dict(data.availability))),
        ).fetchone()[0]
        core.commit()
        for t, rows in data.snapshots.items():
            for r in rows:
                research.execute(
                    "insert into ml_feature_snapshot (model_id, instrument_id, as_of, features, raw) values (%s, %s, %s, %s, %s)",
                    (mid, ids[r.instrument_id], t, json.dumps(dict(r.features)), json.dumps(dict(r.features))),
                )
            for iid, lab in data.labels[t].items():
                research.execute(
                    "insert into ml_label (model_id, instrument_id, as_of, label_end, forward_return) values (%s, %s, %s, %s, %s)",
                    (mid, ids[iid], t, lab.label_end, lab.forward_return),
                )
        research.commit()

    with db.connect(CORE) as core, db.connect(RESEARCH) as research:
        out = cli.catch_up(core, research=research, model_keys=[key])
    written = out[key]["written"]
    assert written > 0

    with psycopg.connect(CORE) as core, psycopg.connect(RESEARCH) as research:
        runs = core.execute("select count(*) from ml_model_run where model_id = %s", (mid,)).fetchone()[0]
        assert runs == written
        # Nothing of the training side landed in Core.
        assert core.execute("select count(*) from ml_feature_snapshot where model_id = %s", (mid,)).fetchone()[0] == 0
        frozen = research.execute("select count(*) from ml_frozen_as_of where model_id = %s", (mid,)).fetchone()[0]
        assert frozen == written
        assert research.execute(
            "select count(*) from ml_evaluation where model_run_id = any(%s::uuid[])",
            ([r[0] for r in core.execute("select id from ml_model_run where model_id = %s", (mid,)).fetchall()],),
        ).fetchone()[0] == written
        assert research.execute("select count(*) from ml_report where model_id = %s", (mid,)).fetchone()[0] == 1
        # A predicted date's snapshots are frozen in the Research Store.
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            research.execute(
                "delete from ml_feature_snapshot where model_id = %s and as_of = "
                "(select min(as_of) from ml_frozen_as_of where model_id = %s)",
                (mid, mid),
            )
    assert uuid.UUID(mid)
