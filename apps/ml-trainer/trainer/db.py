"""Reads and writes for the trainer (ML brief v1 §4), with the worker's database login."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import psycopg

from .protocol import Dataset, Evaluation, Fit, Label, Row


@dataclass(frozen=True)
class Model:
    id: str
    key: str
    name: str
    universe: str
    feature_names: list[str]
    availability: dict[str, str | None]


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, autocommit=False)


def registered_models(conn: psycopg.Connection) -> list[Model]:
    with conn.cursor() as cur:
        cur.execute(
            "select id::text, model_key, name, universe, feature_set, availability "
            "from ml_model where status = 'registered' order by model_key"
        )
        return [
            Model(id=r[0], key=r[1], name=r[2], universe=r[3], feature_names=list(r[4]), availability=r[5] or {})
            for r in cur.fetchall()
        ]


def dataset(conn: psycopg.Connection, model: Model) -> Dataset:
    snapshots: dict[str, list[Row]] = {}
    labels: dict[str, dict[str, Label]] = {}
    with conn.cursor() as cur:
        cur.execute(
            "select as_of::text, instrument_id::text, features from ml_feature_snapshot "
            "where model_id = %s order by as_of, instrument_id",
            (model.id,),
        )
        for as_of, iid, features in cur.fetchall():
            snapshots.setdefault(as_of, []).append(Row(iid, features))
        cur.execute(
            "select as_of::text, instrument_id::text, label_end::text, forward_return from ml_label "
            "where model_id = %s order by as_of, instrument_id",
            (model.id,),
        )
        for as_of, iid, end, ret in cur.fetchall():
            labels.setdefault(as_of, {})[iid] = Label(end, float(ret))
    return Dataset(
        feature_names=model.feature_names,
        snapshots=snapshots,
        labels=labels,
        availability=model.availability,
    )


def served_dates(conn: psycopg.Connection, model: Model) -> set[str]:
    """Prediction dates that already have an active run: never rewritten."""
    with conn.cursor() as cur:
        cur.execute(
            "select prediction_date::text from ml_model_run where model_id = %s and status = 'active'",
            (model.id,),
        )
        return {r[0] for r in cur.fetchall()}


def write_run(conn: psycopg.Connection, model: Model, fit: Fit, code_version: str) -> tuple[str, int]:
    """One run and its predictions, in one transaction (immutable once committed)."""
    with conn.cursor() as cur:
        cur.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"ml_model_run:{model.id}",))
        cur.execute("select coalesce(max(run_no), 0) + 1 from ml_model_run where model_id = %s", (model.id,))
        run_no = int(cur.fetchone()[0])  # type: ignore[index]
        cur.execute(
            "insert into ml_model_run (model_id, run_no, prediction_date, training_start, training_end, "
            "max_label_end, rows_trained, cross_sections, hyperparams, coefficients, code_version) "
            "values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) returning id::text",
            (
                model.id,
                run_no,
                fit.prediction_date,
                fit.training_start,
                fit.training_end,
                fit.max_label_end,
                fit.rows_trained,
                fit.cross_sections,
                json.dumps(
                    {
                        "alpha": fit.alpha,
                        "alphaGrid": [0.1, 1, 10, 100],
                        "cvMeanIc": fit.cv_ic,
                        "validationDates": fit.validation_dates,
                        "window": "expanding",
                    }
                ),
                json.dumps({**fit.coefficients, "(intercept)": fit.intercept}),
                code_version,
            ),
        )
        run_id = cur.fetchone()[0]  # type: ignore[index]
        rows = sorted(fit.scores.items())
        cur.executemany(
            "insert into ml_prediction (model_run_id, instrument_id, as_of, score) values (%s, %s, %s, %s)",
            [(run_id, iid, fit.prediction_date, score) for iid, score in rows],
        )
    conn.commit()
    return run_id, run_no


def runs_to_evaluate(conn: psycopg.Connection, model: Model) -> list[tuple[str, str]]:
    """Active runs without an evaluation whose date has realised labels."""
    with conn.cursor() as cur:
        cur.execute(
            "select r.id::text, r.prediction_date::text from ml_model_run r "
            "where r.model_id = %s and r.status = 'active' "
            "and not exists (select 1 from ml_evaluation e where e.model_run_id = r.id) "
            "and exists (select 1 from ml_label l where l.model_id = r.model_id and l.as_of = r.prediction_date) "
            "order by r.prediction_date",
            (model.id,),
        )
        return [(r[0], r[1]) for r in cur.fetchall()]


def run_scores(conn: psycopg.Connection, run_id: str) -> dict[str, float]:
    with conn.cursor() as cur:
        cur.execute(
            "select instrument_id::text, score from ml_prediction where model_run_id = %s", (run_id,)
        )
        return {r[0]: float(r[1]) for r in cur.fetchall()}


def write_evaluation(conn: psycopg.Connection, run_id: str, as_of: str, ev: Evaluation) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "insert into ml_evaluation (model_run_id, as_of, ic, universe_size, predicted, labelled, decile_spread) "
            "values (%s, %s, %s, %s, %s, %s, %s) on conflict do nothing",
            (run_id, as_of, ev.ic, ev.universe_size, ev.predicted, ev.labelled, ev.decile_spread),
        )
    conn.commit()


def report_inputs(conn: psycopg.Connection, model: Model) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            "select r.run_no, r.prediction_date::text, r.training_start::text, r.training_end::text, "
            "r.max_label_end::text, r.rows_trained, r.cross_sections, r.hyperparams, r.coefficients, "
            "(select count(*) from ml_prediction p where p.model_run_id = r.id), "
            "e.ic, e.universe_size, e.predicted, e.labelled, e.decile_spread "
            "from ml_model_run r left join ml_evaluation e on e.model_run_id = r.id "
            "where r.model_id = %s and r.status = 'active' order by r.prediction_date",
            (model.id,),
        )
        runs = [
            {
                "runNo": r[0],
                "date": r[1],
                "trainingStart": r[2],
                "trainingEnd": r[3],
                "maxLabelEnd": r[4],
                "rowsTrained": r[5],
                "crossSections": r[6],
                "hyperparams": r[7],
                "coefficients": r[8],
                "predicted": r[9],
                "ic": r[10],
                "universeSize": r[11],
                "labelled": r[13],
                "decileSpread": r[14],
            }
            for r in cur.fetchall()
        ]
        cur.execute(
            "select as_of::text, count(*) from ml_feature_snapshot where model_id = %s group by as_of order by as_of",
            (model.id,),
        )
        universe = {r[0]: int(r[1]) for r in cur.fetchall()}
    return {"runs": runs, "universe": universe}


def write_report(conn: psycopg.Connection, model: Model, markdown: str, summary: dict[str, Any], code_version: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "insert into ml_report (model_id, markdown, summary, code_version) values (%s, %s, %s, %s)",
            (model.id, markdown, json.dumps(summary), code_version),
        )
    conn.commit()
