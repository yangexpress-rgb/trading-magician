"""Runs queued pattern scans against the database (brief §6, §11).

The web app queues a `pattern_scan` row with its config (universe members
resolved, the factor catalogue's categories and modes attached). Each batch
run claims the queued scans one at a time, loads the factor store for the
universe and range, mines, and writes the finalists and their occurrences in
one transaction with the scan's result. A scan that fails records why.
"""

from __future__ import annotations

import json
import time
import traceback
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Callable

import numpy as np
import psycopg
from psycopg import sql

from .atoms import Atom
from .decay import decay_state, reverify_checks, score_after
from .labels import excursions
from .scan import DISCOVERY_SHARE, mine, split

MIN_CROSS_SECTION = 50
OWN_LOOKBACK_DAYS = 400
DECAY_EVERY_DAYS = 7


@dataclass(frozen=True)
class FactorDef:
    id: str
    category: str
    modes: list[str]


@dataclass(frozen=True)
class ScanConfig:
    member_ids: list[str]
    direction: str
    threshold: float
    horizon: int
    categories: list[str]
    max_depth: int
    min_support: int
    range_from: str | None
    range_to: str | None
    discovery_share: float
    factors: list[FactorDef]

    @staticmethod
    def parse(raw: dict[str, Any]) -> "ScanConfig":
        outcome = raw["outcome"]
        rng = raw.get("range") or {}
        return ScanConfig(
            member_ids=list(raw["memberIds"]),
            direction=str(outcome["direction"]),
            threshold=float(outcome["pct"]) / 100.0,
            horizon=int(outcome["horizon"]),
            categories=list(raw["categories"]),
            max_depth=int(raw.get("maxDepth", 3)),
            min_support=int(raw.get("minSupport", 40)),
            range_from=rng.get("from"),
            range_to=rng.get("to"),
            discovery_share=float((raw.get("split") or {}).get("discovery", DISCOVERY_SHARE)),
            factors=[FactorDef(f["id"], f["category"], list(f["modes"])) for f in raw["factors"]],
        )


def log(msg: str, **fields: object) -> None:
    print(json.dumps({"msg": msg, **fields}, default=str), flush=True)


def claim_scan(conn: psycopg.Connection) -> tuple[str, str, dict[str, Any]] | None:
    """The oldest queued scan, marked running (skip-locked, so two runs never share one)."""
    with conn.cursor() as cur:
        cur.execute(
            "update pattern_scan set status = 'running', started_at = now() "
            "where id = (select id from pattern_scan where status = 'queued' "
            "order by created_at limit 1 for update skip locked) "
            "returning id::text, user_id::text, config"
        )
        row = cur.fetchone()
    conn.commit()
    return (row[0], row[1], row[2]) if row else None


def category_starts(conn: psycopg.Connection, factors: list[FactorDef]) -> dict[str, str | None]:
    """Per category, the first day any of its factors could form an atom (§3, §12)."""
    out: dict[str, str | None] = {}
    with conn.cursor() as cur:
        cur.execute(
            "select factor, min(as_of)::text, "
            "min(as_of) filter (where known >= %s)::text from factor_coverage group by factor",
            (MIN_CROSS_SECTION,),
        )
        cov = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    for f in factors:
        first_any, first_cross = cov.get(f.id, (None, None))
        start = first_cross if "cross" in f.modes else first_any
        if start is None:
            out.setdefault(f.category, None)
            continue
        prev = out.get(f.category)
        out[f.category] = start if prev is None else min(prev, start)
    return out


def last_snapshot_day(conn: psycopg.Connection) -> str | None:
    with conn.cursor() as cur:
        cur.execute("select max(as_of)::text from factor_coverage where factor = '_rows'")
        row = cur.fetchone()
    return row[0] if row else None


@dataclass
class Grid:
    days: list[str]
    inst: list[str]
    factors: dict[str, np.ndarray]
    close_ret: np.ndarray
    high_rel: np.ndarray
    low_rel: np.ndarray


def load_grid(conn: psycopg.Connection, member_ids: list[str], factor_ids: list[str], start: str, end: str) -> Grid:
    """The factor store for the members from `start` to `end`, as (day, instrument) grids."""
    with conn.cursor() as cur:
        cur.execute(
            "select distinct as_of::text from factor_snapshot "
            "where instrument_id = any(%s::uuid[]) and as_of between %s and %s order by 1",
            (member_ids, start, end),
        )
        days = [r[0] for r in cur.fetchall()]
    day_ix = {d: k for k, d in enumerate(days)}
    inst_ix = {iid: k for k, iid in enumerate(member_ids)}
    shape = (len(days), len(member_ids))
    grids = {f: np.full(shape, np.nan, dtype=np.float32) for f in factor_ids}
    close_ret = np.full(shape, np.nan)
    high_rel = np.full(shape, np.nan)
    low_rel = np.full(shape, np.nan)
    cols = [sql.SQL("(values->>{})::float8").format(sql.Literal(f)) for f in factor_ids]
    query = sql.SQL(
        "select as_of::text, instrument_id::text, close_ret, high_rel, low_rel{} from factor_snapshot "
        "where instrument_id = any(%s::uuid[]) and as_of between %s and %s"
    ).format(sql.SQL("").join(sql.SQL(", ") + c for c in cols))
    with conn.cursor(name="factor_grid") as cur:
        cur.itersize = 20000
        cur.execute(query, (member_ids, start, end))
        for row in cur:
            d = day_ix[row[0]]
            i = inst_ix[row[1]]
            if row[2] is not None:
                close_ret[d, i] = row[2]
            if row[3] is not None:
                high_rel[d, i] = row[3]
            if row[4] is not None:
                low_rel[d, i] = row[4]
            for k, f in enumerate(factor_ids):
                v = row[5 + k]
                if v is not None:
                    grids[f][d, i] = v
    conn.commit()
    return Grid(days, member_ids, grids, close_ret, high_rel, low_rel)


def _iso(d: str, days: int) -> str:
    return (date.fromisoformat(d) + timedelta(days=days)).isoformat()


def run_scan(conn: psycopg.Connection, scan_id: str, user_id: str, raw: dict[str, Any], code_version: str) -> dict[str, Any]:
    started = time.time()
    cfg = ScanConfig.parse(raw)
    included = [f for f in cfg.factors if f.category in cfg.categories]
    starts = category_starts(conn, included)
    last = last_snapshot_day(conn)
    usable_starts = [s for c, s in starts.items() if s is not None]
    if not usable_starts or last is None:
        raise ValueError("The factor store has no data for the chosen categories yet")
    # The range never reaches further back than any included category's coverage (§3, §12).
    start = max(usable_starts + ([cfg.range_from] if cfg.range_from else []))
    end = min([last] + ([cfg.range_to] if cfg.range_to else []))
    if start >= end:
        raise ValueError(f"No days in range: from {start} to {end}")
    dropped = sorted(c for c, s in starts.items() if s is None)
    factor_ids = [f.id for f in included if starts.get(f.category)]
    grid = load_grid(conn, cfg.member_ids, factor_ids, _iso(start, -OWN_LOOKBACK_DAYS), end)
    first = next((k for k, d in enumerate(grid.days) if d >= start), None)
    if first is None or len(grid.days) - first < cfg.horizon * 3:
        raise ValueError("Too few days of data in the scan range")
    end_ix = len(grid.days) - 1
    windows = split(first, end_ix, cfg.horizon, cfg.discovery_share)
    outcomes = excursions(grid.close_ret, grid.high_rel, grid.low_rel, cfg.horizon)
    modes = {f.id: f.modes for f in included if f.id in grid.factors}
    out = mine(
        grid.factors,
        modes,
        outcomes,
        direction=cfg.direction,
        threshold=cfg.threshold,
        windows=windows,
        max_depth=cfg.max_depth,
        min_support=cfg.min_support,
    )
    res = out.result
    seconds = round(time.time() - started, 1)
    effective = {
        "from": grid.days[first],
        "to": grid.days[end_ix],
        "discoveryEnd": grid.days[windows.disc_end],
        "holdoutStart": grid.days[min(windows.disc_end + 1, end_ix)],
        "categories": {c: {"from": s} for c, s in sorted(starts.items())},
        "excludedCategories": dropped,
        "discoveryBaseRate": res.discovery_base,
        "holdoutBaseRate": res.holdout_base,
        "discoveryCells": res.discovery_cells,
        "holdoutCells": res.holdout_cells,
        "levels": res.levels,
        "atoms": len(out.atoms),
        "suppressed": res.suppressed,
        "instruments": len(grid.inst),
    }
    verified = sum(1 for f in res.finalists if f.verified)
    with conn.cursor() as cur:
        for rank, f in enumerate(res.finalists, start=1):
            rule = [out.atoms[i].as_json() for i in f.rule.atoms]
            stats = {
                "discovery": f.discovery.as_json(),
                "holdout": f.holdout.as_json(),
                "level": f.rule.level,
                "failedChecks": f.reasons,
            }
            cur.execute(
                "insert into pattern (scan_id, user_id, rank, rule, stats, status) "
                "values (%s, %s, %s, %s, %s, %s) returning id::text",
                (scan_id, user_id, rank, json.dumps(rule), json.dumps(stats), "verified" if f.verified else "candidate"),
            )
            pid = cur.fetchone()[0]  # type: ignore[index]
            cur.executemany(
                "insert into pattern_occurrence (pattern_id, user_id, instrument_id, as_of, \"window\", hit, "
                "max_runup, max_drawdown, forward_return) values (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
                [
                    (pid, user_id, grid.inst[o.inst], grid.days[o.day], o.window, o.hit, o.runup, o.drawdown, o.forward)
                    for o in out.occurrences[rank - 1]
                ],
            )
        cur.execute(
            "update pattern_scan set status = 'done', candidates_tested = %s, finalists = %s, verified = %s, "
            "effective = %s, code_version = %s, seconds = %s, finished_at = now(), error = null where id = %s",
            (res.candidates_tested, len(res.finalists), verified, json.dumps(effective), code_version, seconds, scan_id),
        )
    conn.commit()
    return {"scan": scan_id, "candidatesTested": res.candidates_tested, "finalists": len(res.finalists), "verified": verified, "seconds": seconds}


def run_queued(conn: psycopg.Connection, code_version: str, *, limit: int = 20, on_scan: Callable[[dict[str, Any]], None] | None = None) -> list[dict[str, Any]]:
    """Every queued scan, oldest first (up to `limit` per batch run)."""
    done: list[dict[str, Any]] = []
    for _ in range(limit):
        claimed = claim_scan(conn)
        if not claimed:
            break
        scan_id, user_id, raw = claimed
        log("pattern scan started", scan=scan_id)
        try:
            result = run_scan(conn, scan_id, user_id, raw, code_version)
        except Exception as e:  # noqa: BLE001 - recorded on the scan, never lost
            conn.rollback()
            message = str(e)[:500] or e.__class__.__name__
            with conn.cursor() as cur:
                cur.execute(
                    "update pattern_scan set status = 'failed', error = %s, finished_at = now(), code_version = %s where id = %s",
                    (message, code_version, scan_id),
                )
            conn.commit()
            log("pattern scan failed", scan=scan_id, error=message, trace=traceback.format_exc()[-1500:])
            result = {"scan": scan_id, "failed": message}
        else:
            log("pattern scan done", **result)
        if on_scan:
            on_scan(result)
        done.append(result)
    return done


def _due_patterns(conn: psycopg.Connection, today: str) -> list[tuple[Any, ...]]:
    """Verified patterns not scored in the last week, or with a re-verify requested (§10)."""
    with conn.cursor() as cur:
        cur.execute(
            "select p.id::text, p.user_id::text, p.scan_id::text, p.rule, coalesce(p.decay_stats, '{}'::jsonb), "
            "s.config, s.effective from pattern p join pattern_scan s on s.id = p.scan_id "
            "where p.status = 'verified' and s.status = 'done' and ("
            "p.last_scored is null or p.last_scored <= %s::date - %s::int "
            "or p.decay_stats ? 'reverifyRequestedAt') order by p.scan_id, p.rank",
            (today, DECAY_EVERY_DAYS),
        )
        rows = cur.fetchall()
    conn.commit()
    return rows


def _last_index_on_or_before(days: list[str], day: str) -> int:
    k = -1
    for i, d in enumerate(days):
        if d <= day:
            k = i
        else:
            break
    return k


def run_decay(conn: psycopg.Connection, code_version: str, *, today: str | None = None) -> list[dict[str, Any]]:
    """Re-scores due Verified patterns on fresh data and runs requested re-verifications (§10)."""
    today = today or date.today().isoformat()
    last = last_snapshot_day(conn)
    if last is None:
        return []
    by_scan: dict[str, list[tuple[Any, ...]]] = {}
    for row in _due_patterns(conn, today):
        by_scan.setdefault(row[2], []).append(row)
    done: list[dict[str, Any]] = []
    for scan_id, rows in by_scan.items():
        cfg = ScanConfig.parse(rows[0][5])
        eff = rows[0][6] or {}
        holdout_end, disc_end = eff.get("to"), eff.get("discoveryEnd")
        if not holdout_end or not disc_end:
            continue
        rules = {r[0]: [Atom(a["factor"], a["mode"], a["bucket"]) for a in r[3]] for r in rows}
        factor_ids = sorted({a.factor for rule in rules.values() for a in rule})
        wants_reverify = any("reverifyRequestedAt" in r[4] for r in rows)
        first_needed = disc_end if wants_reverify else holdout_end
        grid = load_grid(conn, cfg.member_ids, factor_ids, _iso(first_needed, -OWN_LOOKBACK_DAYS), last)
        if not grid.days:
            continue
        outcomes = excursions(grid.close_ret, grid.high_rel, grid.low_rel, cfg.horizon)
        fresh_after = _last_index_on_or_before(grid.days, holdout_end)
        disc_after = _last_index_on_or_before(grid.days, disc_end)
        for pid, user_id, _scan, _rule, stats_in, _cfg, _eff in rows:
            rule = rules[pid]
            kw = dict(direction=cfg.direction, threshold=cfg.threshold, horizon=cfg.horizon)
            fresh = score_after(grid.factors, rule, outcomes, after=fresh_after, **kw)  # type: ignore[arg-type]
            state = decay_state(fresh.stats)
            stats = {k: v for k, v in dict(stats_in).items() if k != "reverifyRequestedAt"}
            stats["fresh"] = fresh.stats.as_json()
            stats["freshFrom"] = grid.days[min(fresh_after + 1, len(grid.days) - 1)]
            stats["codeVersion"] = code_version
            if "reverifyRequestedAt" in stats_in:
                rv = score_after(grid.factors, rule, outcomes, after=disc_after, window="holdout", **kw)  # type: ignore[arg-type]
                failed = reverify_checks(rv.stats)
                stats["reverify"] = {
                    "stats": rv.stats.as_json(),
                    "from": grid.days[min(disc_after + 1, len(grid.days) - 1)],
                    "to": last,
                    "verified": not failed,
                    "failedChecks": failed,
                    "requestedAt": stats_in["reverifyRequestedAt"],
                }
            with conn.cursor() as cur:
                cur.executemany(
                    "insert into pattern_occurrence (pattern_id, user_id, instrument_id, as_of, \"window\", hit, "
                    "max_runup, max_drawdown, forward_return) values (%s, %s, %s, %s, 'fresh', %s, %s, %s, %s) "
                    "on conflict do nothing",
                    [
                        (pid, user_id, grid.inst[o.inst], grid.days[o.day], o.hit, o.runup, o.drawdown, o.forward)
                        for o in fresh.occurrences
                    ],
                )
                cur.execute(
                    "update pattern set decay_state = %s, decay_stats = %s, last_scored = %s where id = %s",
                    (state, json.dumps(stats), last, pid),
                )
            conn.commit()
            result = {"pattern": pid, "fresh": fresh.stats.n, "state": state}
            if "reverify" in stats:
                result["reverified"] = stats["reverify"]["verified"]
            log("pattern scored", **result)
            done.append(result)
    return done
