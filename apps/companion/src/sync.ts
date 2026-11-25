import type postgres from 'postgres';
import type { CompanionClient, Instrument, MembershipPeriod } from './api';

/**
 * Pulls the cloud's read-only reference data into the local store: the
 * instrument list (no demo instruments) and point-in-time group membership.
 * The cloud stays the source; the local copy is replaced wholesale on each
 * pull so it never drifts.
 */

const CHUNK = 500;

export async function saveInstruments(sql: postgres.Sql, rows: Instrument[]): Promise<number> {
  await sql.begin(async (tx) => {
    await tx`create temporary table incoming (like companion.instrument including defaults) on commit drop`;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({
        id: r.id,
        symbol: r.symbol,
        asset_class: r.assetClass,
        kind: r.kind,
        display_name: r.displayName,
        venue: r.venue,
        currency: r.currency,
      }));
      await tx`insert into incoming ${tx(chunk)}`;
    }
    await tx`delete from companion.instrument c where not exists (select 1 from incoming i where i.id = c.id)`;
    await tx`
      insert into companion.instrument (id, symbol, asset_class, kind, display_name, venue, currency, synced_at)
      select id, symbol, asset_class, kind, display_name, venue, currency, now() from incoming
      on conflict (id) do update set
        symbol = excluded.symbol,
        asset_class = excluded.asset_class,
        kind = excluded.kind,
        display_name = excluded.display_name,
        venue = excluded.venue,
        currency = excluded.currency,
        synced_at = excluded.synced_at`;
  });
  return rows.length;
}

export async function saveMembership(sql: postgres.Sql, rows: MembershipPeriod[]): Promise<number> {
  await sql.begin(async (tx) => {
    await tx`delete from companion.membership_period`;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({
        group_id: r.groupId,
        symbol: r.symbol,
        instrument_id: r.instrumentId,
        from_date: r.fromDate,
        to_date: r.toDate,
      }));
      await tx`insert into companion.membership_period ${tx(chunk)}`;
    }
  });
  return rows.length;
}

/** Records how a job went, for `status` and for the catch-up after time offline. */
export async function recordJob(
  sql: postgres.Sql,
  job: string,
  outcome: { ok: true; detail?: Record<string, unknown> } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    const detail = JSON.stringify(outcome.detail ?? {});
    await sql`
      insert into companion.sync_state (job, ok_at, tried_at, error, detail)
      values (${job}, now(), now(), null, ${detail}::jsonb)
      on conflict (job) do update set ok_at = now(), tried_at = now(), error = null, detail = excluded.detail`;
  } else {
    await sql`
      insert into companion.sync_state (job, ok_at, tried_at, error)
      values (${job}, null, now(), ${outcome.error.slice(0, 500)})
      on conflict (job) do update set tried_at = now(), error = excluded.error`;
  }
}

export interface JobState {
  job: string;
  okAt: Date | null;
  triedAt: Date;
  error: string | null;
  detail: Record<string, unknown>;
}

export async function jobStates(sql: postgres.Sql): Promise<JobState[]> {
  const rows = await sql<
    {
      job: string;
      ok_at: Date | null;
      tried_at: Date;
      error: string | null;
      detail: Record<string, unknown>;
    }[]
  >`select job, ok_at, tried_at, error, detail from companion.sync_state order by job`;
  return rows.map((r) => ({
    job: r.job,
    okAt: r.ok_at,
    triedAt: r.tried_at,
    error: r.error,
    detail: r.detail,
  }));
}

/** Pulls instruments and membership; returns the counts. */
export async function pullReference(
  sql: postgres.Sql,
  client: CompanionClient,
): Promise<{ instruments: number; periods: number }> {
  const instruments = await saveInstruments(sql, await client.allInstruments());
  const periods = await saveMembership(sql, await client.membership());
  return { instruments, periods };
}
