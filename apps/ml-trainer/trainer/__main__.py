"""Catch up every registered model series (ML brief v1 §3, §9).

For each prediction date with snapshots and no active run, refit and write a
run with its predictions; then evaluate runs whose labels have realised; then
write the report. Resumable and idempotent: a date with an active run is never
rewritten, so the historical backfill and the monthly run are the same command.
Off unless ML_TRAINER_ENABLED=on.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import __version__, db, protocol, report


def log(msg: str, **fields: object) -> None:
    print(json.dumps({"msg": msg, **fields}, default=str), flush=True)


def code_version() -> str:
    sha = os.environ.get("RAILWAY_GIT_COMMIT_SHA") or os.environ.get("GIT_SHA")
    return f"ml-trainer {__version__}" + (f" @ {sha[:12]}" if sha else "")


def catch_up(conn, *, model_keys: list[str] | None = None, until_year: int | None = None, write_report: bool = True, force_report: bool = False) -> dict[str, object]:
    out: dict[str, object] = {}
    version = code_version()
    for model in db.registered_models(conn):
        if model_keys and model.key not in model_keys:
            continue
        data = db.dataset(conn, model)
        served = db.served_dates(conn, model)
        pending = [d for d in sorted(data.snapshots) if d not in served]
        if until_year is not None:
            pending = [d for d in pending if int(d[:4]) <= until_year]
        written, skipped = [], {}
        # Chunked by calendar year, each date committed on its own (§9: resumable).
        for year in sorted({d[:4] for d in pending}):
            for date in [d for d in pending if d.startswith(year)]:
                try:
                    fit = protocol.fit_for(data, date)
                except protocol.NotTrainable as e:
                    skipped[date] = str(e)
                    continue
                run_id, run_no = db.write_run(conn, model, fit, version)
                written.append(date)
                log("run written", model=model.key, date=date, run=run_no, alpha=fit.alpha,
                    rows=fit.rows_trained, predicted=len(fit.scores), maxLabelEnd=fit.max_label_end)
            log("year done", model=model.key, year=year, written=len([d for d in written if d.startswith(year)]))
        evaluated = 0
        for run_id, date in db.runs_to_evaluate(conn, model):
            scores = db.run_scores(conn, run_id)
            ev = protocol.evaluate(scores, len(data.snapshots.get(date, [])), data.labels.get(date, {}))
            db.write_evaluation(conn, run_id, date, ev)
            evaluated += 1
        summary = None
        if write_report and (written or evaluated or force_report):
            markdown, summary = report.build(model.key, model.name, model.feature_names, model.availability, db.report_inputs(conn, model))
            db.write_report(conn, model, markdown, summary, version)
            report_dir = os.environ.get("ML_REPORT_DIR")
            if report_dir:
                os.makedirs(report_dir, exist_ok=True)
                with open(os.path.join(report_dir, f"{model.key}.md"), "w", encoding="utf-8") as f:
                    f.write(markdown)
        not_trainable = sorted(skipped)
        out[model.key] = {
            "written": len(written),
            "evaluated": evaluated,
            "notTrainable": len(not_trainable),
            "firstNotTrainable": skipped[not_trainable[0]] if not_trainable else None,
            "summary": summary,
        }
        log("model done", model=model.key, **{k: v for k, v in out[model.key].items() if k != "summary"})
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="trainer", description=__doc__)
    parser.add_argument("--model", action="append", help="only this model key (repeatable)")
    parser.add_argument("--until-year", type=int, help="stop after this calendar year (backfill in steps)")
    parser.add_argument("--no-report", action="store_true")
    parser.add_argument("--report", action="store_true", help="write the report even when nothing changed")
    args = parser.parse_args(argv)
    ml_on = os.environ.get("ML_TRAINER_ENABLED", "off") == "on"
    # Pattern discovery's miner runs in the same batch service (pattern brief §11, ADR 0091).
    patterns_on = os.environ.get("PATTERN_MINER_ENABLED", "off") == "on"
    if not ml_on and not patterns_on:
        log("trainer is switched off (ML_TRAINER_ENABLED and PATTERN_MINER_ENABLED are not 'on'); nothing done")
        return 0
    url = os.environ.get("DATABASE_WORKER_URL") or os.environ.get("DATABASE_URL")
    if not url:
        log("no DATABASE_WORKER_URL set")
        return 2
    started = time.time()
    with db.connect(url) as conn:
        if ml_on:
            result = catch_up(conn, model_keys=args.model, until_year=args.until_year, write_report=not args.no_report, force_report=args.report)
            log("trainer finished", seconds=round(time.time() - started, 1),
                models={k: {kk: vv for kk, vv in v.items() if kk != "summary"} for k, v in result.items()})  # type: ignore[union-attr]
        else:
            log("ML training is switched off (ML_TRAINER_ENABLED is not 'on')")
        if patterns_on:
            from miner import __version__ as miner_version
            from miner.run import run_queued

            scans = run_queued(conn, f"miner {miner_version}" + code_version().removeprefix(f"ml-trainer {__version__}"))
            log("pattern miner finished", scans=len(scans))
    return 0


if __name__ == "__main__":
    sys.exit(main())
