import type postgres from 'postgres';
import type { CompanionClient, MlRun } from './api';

/**
 * ML on the companion (ADR 0117, S2 step 3a). One pass:
 *
 * 1. Mirror the cloud's model registry and active runs (with their
 *    predictions) into the local store, so the trainer sees which dates are
 *    already served, exactly as it would in Core.
 * 2. Run the trainer (Python, unchanged) against the local store.
 * 3. Push what the companion made: new runs with their predictions, then
 *    evaluations, then reports. The cloud queues each push and its worker
 *    applies it; a date the cloud already serves is never rewritten.
 */

export interface MirrorResult {
  models: number;
  runsAdded: number;
  localRunsReplaced: number;
}

/** Brings the local mirror in line with the cloud's registry and active runs. */
export async function syncMlMirror(
  sql: postgres.Sql,
  client: CompanionClient,
): Promise<MirrorResult> {
  const state = await client.mlState();
  await sql.begin(async (tx) => {
    for (const m of state.models) {
      await tx`
        insert into ml_model (id, model_key, name, universe, feature_set, feature_set_version, label,
                              algorithm, status, snapshots_from, availability)
        values (${m.id}, ${m.modelKey}, ${m.name}, ${m.universe}, ${JSON.stringify(m.featureSet)}::jsonb,
                ${m.featureSetVersion}, ${JSON.stringify(m.label)}::jsonb, ${m.algorithm}, ${m.status},
                ${m.snapshotsFrom}, ${m.availability == null ? null : JSON.stringify(m.availability)}::jsonb)
        on conflict (id) do update set
          model_key = excluded.model_key, name = excluded.name, universe = excluded.universe,
          feature_set = excluded.feature_set, feature_set_version = excluded.feature_set_version,
          label = excluded.label, algorithm = excluded.algorithm, status = excluded.status,
          snapshots_from = excluded.snapshots_from,
          -- The companion's own report wins once its snapshots made one (ADR 0118): the
          -- snapshot job's saveAvailability moves updated_at; this mirror never does.
          availability = case when ml_model.updated_at > ml_model.created_at
                              then ml_model.availability else excluded.availability end`;
    }
  });
  let runsAdded = 0;
  let localRunsReplaced = 0;
  const local = await sql<{ id: string; model_id: string; prediction_date: string }[]>`
    select id::text, model_id::text, prediction_date::text from ml_model_run where status = 'active'`;
  const localIds = new Set(local.map((r) => r.id));
  const localByDate = new Map(local.map((r) => [`${r.model_id}|${r.prediction_date}`, r.id]));
  for (const run of state.runs) {
    if (localIds.has(run.id)) continue;
    const predictions = await client.runPredictions(run.id);
    const clash = localByDate.get(`${run.modelId}|${run.predictionDate}`);
    await sql.begin(async (tx) => {
      if (clash) {
        // The cloud served this date first (another producer, or the cloud's own
        // trainer before hand-over): its run wins and the local one goes. The
        // research tables refuse deletes by trigger; this local mirror may.
        await tx`set local session_replication_role = replica`;
        await tx`delete from ml_evaluation where model_run_id = ${clash}`;
        await tx`delete from ml_model_run where id = ${clash}`;
        localRunsReplaced += 1;
      }
      await insertRun(tx, run, predictions);
    });
    runsAdded += 1;
  }
  return { models: state.models.length, runsAdded, localRunsReplaced };
}

async function insertRun(tx: postgres.TransactionSql, run: MlRun, predictions: [string, number][]) {
  await tx`
    insert into ml_model_run (id, model_id, run_no, prediction_date, training_start, training_end,
                              max_label_end, rows_trained, cross_sections, hyperparams, coefficients,
                              code_version, status, source, created_at)
    values (${run.id}, ${run.modelId}, ${run.runNo}, ${run.predictionDate}, ${run.trainingStart},
            ${run.trainingEnd}, ${run.maxLabelEnd}, ${run.rowsTrained}, ${run.crossSections},
            ${JSON.stringify(run.hyperparams)}::jsonb, ${JSON.stringify(run.coefficients)}::jsonb,
            ${run.codeVersion}, 'active', ${run.source}, ${run.createdAt})`;
  for (let i = 0; i < predictions.length; i += 1000) {
    const rows = predictions.slice(i, i + 1000).map(([instrumentId, score]) => ({
      model_run_id: run.id,
      instrument_id: instrumentId,
      as_of: run.predictionDate,
      score,
    }));
    await tx`insert into ml_prediction ${tx(rows)}`;
  }
  await tx`
    insert into ml_frozen_as_of (model_id, as_of) values (${run.modelId}, ${run.predictionDate})
    on conflict do nothing`;
  // The cloud's runs are already there: never push them back.
  await tx`
    insert into companion.pushed (client_key, kind, push_id)
    values (${`run:${run.id}`}, 'ml_run', ${run.id}) on conflict do nothing`;
}

export interface PushResult {
  runs: number;
  evaluations: number;
  reports: number;
}

async function pushOnce(
  sql: postgres.Sql,
  client: CompanionClient,
  kind: 'ml_run' | 'ml_evaluation' | 'ml_report',
  clientKey: string,
  payload: unknown,
): Promise<void> {
  const reply = await client.push(kind, clientKey, payload);
  await sql`
    insert into companion.pushed (client_key, kind, push_id)
    values (${clientKey}, ${kind}, ${reply.pushId}) on conflict do nothing`;
}

/** Pushes the runs, evaluations and reports the companion made and has not sent yet. */
export async function pushMlOutputs(
  sql: postgres.Sql,
  client: CompanionClient,
): Promise<PushResult> {
  const out: PushResult = { runs: 0, evaluations: 0, reports: 0 };
  const runs = await sql<
    {
      id: string;
      model_key: string;
      prediction_date: string;
      training_start: string;
      training_end: string;
      max_label_end: string;
      rows_trained: number;
      cross_sections: number;
      hyperparams: Record<string, unknown>;
      coefficients: Record<string, number | null>;
      code_version: string;
    }[]
  >`
    select r.id::text, m.model_key, r.prediction_date::text, r.training_start::text,
           r.training_end::text, r.max_label_end::text, r.rows_trained, r.cross_sections,
           r.hyperparams, r.coefficients, r.code_version
    from ml_model_run r join ml_model m on m.id = r.model_id
    where r.status = 'active'
      and not exists (select 1 from companion.pushed p where p.client_key = 'run:' || r.id::text)
    order by r.prediction_date`;
  for (const r of runs) {
    const predictions = await sql<{ instrument_id: string; score: number }[]>`
      select instrument_id::text, score from ml_prediction where model_run_id = ${r.id} order by instrument_id`;
    await pushOnce(sql, client, 'ml_run', `run:${r.id}`, {
      run: {
        id: r.id,
        modelKey: r.model_key,
        predictionDate: r.prediction_date,
        trainingStart: r.training_start,
        trainingEnd: r.training_end,
        maxLabelEnd: r.max_label_end,
        rowsTrained: r.rows_trained,
        crossSections: r.cross_sections,
        hyperparams: r.hyperparams,
        coefficients: r.coefficients,
        codeVersion: r.code_version,
      },
      predictions: predictions.map((p) => [p.instrument_id, Number(p.score)]),
    });
    out.runs += 1;
  }
  const evals = await sql<
    {
      model_run_id: string;
      as_of: string;
      ic: number | null;
      universe_size: number;
      predicted: number;
      labelled: number;
      decile_spread: number | null;
    }[]
  >`
    select e.model_run_id::text, e.as_of::text, e.ic, e.universe_size, e.predicted, e.labelled, e.decile_spread
    from ml_evaluation e
    where exists (select 1 from ml_model_run r where r.id = e.model_run_id and r.status = 'active')
      and not exists (select 1 from companion.pushed p where p.client_key = 'eval:' || e.model_run_id::text)
    order by e.as_of`;
  for (const e of evals) {
    await pushOnce(sql, client, 'ml_evaluation', `eval:${e.model_run_id}`, {
      modelRunId: e.model_run_id,
      asOf: e.as_of,
      ic: e.ic === null ? null : Number(e.ic),
      universeSize: e.universe_size,
      predicted: e.predicted,
      labelled: e.labelled,
      decileSpread: e.decile_spread === null ? null : Number(e.decile_spread),
    });
    out.evaluations += 1;
  }
  const reports = await sql<
    {
      id: string;
      model_key: string;
      markdown: string;
      summary: Record<string, unknown>;
      code_version: string;
    }[]
  >`
    select r.id::text, m.model_key, r.markdown, r.summary, r.code_version
    from ml_report r join ml_model m on m.id = r.model_id
    where not exists (select 1 from companion.pushed p where p.client_key = 'report:' || r.id::text)
    order by r.created_at`;
  for (const r of reports) {
    await pushOnce(sql, client, 'ml_report', `report:${r.id}`, {
      id: r.id,
      modelKey: r.model_key,
      markdown: r.markdown,
      summary: r.summary,
      codeVersion: r.code_version,
    });
    out.reports += 1;
  }
  return out;
}

/** Pushes the cloud refused, for status (it keeps the reason). */
export async function refusedPushes(client: CompanionClient) {
  return (await client.openPushes()).filter((p) => p.error);
}
