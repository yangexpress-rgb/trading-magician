import type { PatternDecayDueAnswer, PatternScanAnswer } from '@tm/db';
import type postgres from 'postgres';
import type { CompanionClient } from './api';
import type { CloudData } from './cloud-data';
import { pushOnce } from './ml';
import type { RunResult } from './python';

/**
 * Pattern mining on the companion (ADR 0120, S2 step 3c-ii). One pass:
 *
 * 1. Send up any scan the miner finished here and has not sent yet (also
 *    after a crash or a restart).
 * 2. Run a scan the miner started here but did not finish, if any.
 * 3. Otherwise claim the oldest queued scan in the cloud, copy it into the
 *    local store as queued, and run the miner (Python, unchanged) on the
 *    local factor store; then send its result up.
 *
 * The cloud keeps the scan `running` from the claim until the result lands;
 * its pages read the scan, its patterns and their occurrences from there.
 *
 * Decay (ADR 0121, step 4): each pass also copies in the cloud's Verified
 * patterns due a decay score, lets the same miner run score them on the local
 * factor store, and sends each new score up with its fresh occurrences.
 */

export type MinerRunner = (storeUrl: string) => Promise<RunResult>;

export interface MiningResult {
  claimed: string | null;
  pushed: number;
  /** Patterns pulled to score decay on, and decay scores sent up. */
  decayDue: number;
  decayPushed: number;
}

/** Fresh occurrences in one decay push. */
export const DECAY_PART_SIZE = 20_000;
/** Occurrences per scan-result push (N350): about 2.5 MB of JSON, under the cloud's 4 MB limit. */
export const SCAN_PART_SIZE = 15_000;

/**
 * Splits a scan's patterns into parts of at most `size` occurrences. Every pattern goes in the
 * first part it has occurrences in (or the first part, if it has none), and again with each
 * later slice of its occurrences.
 */
export function scanParts<P extends { occurrences: readonly unknown[] }>(
  patterns: readonly P[],
  size: number,
): P[][] {
  let current: P[] = [];
  const parts: P[][] = [current];
  let room = size;
  for (const p of patterns) {
    if (p.occurrences.length === 0) {
      current.push(p);
      continue;
    }
    for (let i = 0; i < p.occurrences.length;) {
      if (room === 0) {
        current = [];
        parts.push(current);
        room = size;
      }
      const take = Math.min(room, p.occurrences.length - i);
      current.push({ ...p, occurrences: p.occurrences.slice(i, i + take) });
      i += take;
      room -= take;
    }
  }
  return parts;
}
/**
 * Fresh occurrences resent from this many days before the cloud's last score:
 * one dated earlier becomes known only once its horizon has passed. The cloud
 * keeps the ones it already has.
 */
const DECAY_RESEND_DAYS = 90;

type LocalScan = {
  id: string;
  status: 'done' | 'failed';
  error: string | null;
  candidates_tested: number | null;
  finalists: number | null;
  verified: number | null;
  effective: Record<string, unknown> | null;
  code_version: string | null;
  seconds: number | null;
};

/** Pushes finished local scans not sent yet; returns how many. */
export async function pushFinishedScans(
  sql: postgres.Sql,
  client: CompanionClient,
): Promise<number> {
  const scans = await sql<
    {
      id: string;
      status: 'done' | 'failed';
      error: string | null;
      candidates_tested: number | null;
      finalists: number | null;
      verified: number | null;
      effective: Record<string, unknown> | null;
      code_version: string | null;
      seconds: number | null;
    }[]
  >`
    select id::text, status, error, candidates_tested, finalists, verified, effective,
           code_version, seconds
    from pattern_scan s
    where status in ('done', 'failed')
      and not exists (select 1 from companion.pushed p where p.client_key = 'scan:' || s.id::text)
    order by finished_at`;
  for (const scan of scans) await pushScan(sql, client, scan, `scan:${scan.id}`);
  return scans.length;
}

async function pushScan(
  sql: postgres.Sql,
  client: CompanionClient,
  scan: LocalScan,
  clientKey: string,
): Promise<void> {
  {
    const patterns = await sql<
      {
        id: string;
        rank: number;
        rule: unknown[];
        stats: Record<string, unknown>;
        status: 'candidate' | 'verified';
      }[]
    >`select id::text, rank, rule, stats, status from pattern where scan_id = ${scan.id} order by rank`;
    const withOccurrences = [];
    for (const p of patterns) {
      // The scan's own evidence only: live ("fresh") occurrences are the decay job's.
      const occ = await sql<
        {
          instrument_id: string;
          as_of: string;
          window: 'discovery' | 'holdout';
          hit: boolean;
          max_runup: number;
          max_drawdown: number;
          forward_return: number;
        }[]
      >`
        select instrument_id::text, as_of::text, "window", hit, max_runup, max_drawdown, forward_return
        from pattern_occurrence where pattern_id = ${p.id} and "window" in ('discovery', 'holdout')
        order by as_of, instrument_id`;
      withOccurrences.push({
        ...p,
        occurrences: occ.map(
          (o) =>
            [
              o.instrument_id,
              o.as_of,
              o.window,
              o.hit,
              Number(o.max_runup),
              Number(o.max_drawdown),
              Number(o.forward_return),
            ] as const,
        ),
      });
    }
    const summary = {
      id: scan.id,
      status: scan.status,
      error: scan.error,
      candidatesTested: scan.candidates_tested,
      finalists: scan.finalists,
      verified: scan.verified,
      effective: scan.effective,
      codeVersion: scan.code_version,
      seconds: scan.seconds === null ? null : Number(scan.seconds),
    };
    // A big scan goes up in parts (N350); the last part, under the scan's own key, sets its outcome.
    const parts = scanParts(withOccurrences, SCAN_PART_SIZE);
    for (let i = 0; i < parts.length; i += 1) {
      const last = i === parts.length - 1;
      await pushOnce(sql, client, 'pattern_scan_result', last ? clientKey : `${clientKey}:p${i}`, {
        scan: summary,
        patterns: parts[i],
        ...(last ? {} : { partial: true }),
      });
    }
  }
}

/** Copies the cloud's Verified patterns due a decay score into the local store; returns how many. */
export async function pullDecayDue(
  sql: postgres.Sql,
  cloud: CloudData,
  today: string,
): Promise<number> {
  const { patterns } = await cloud.ask<PatternDecayDueAnswer>('pattern_decay_due', { today });
  for (const p of patterns) {
    await sql`
      insert into pattern_scan (id, user_id, config, summary, status, effective, created_at)
      values (${p.scan.id}, ${p.scan.userId}, ${JSON.stringify(p.scan.config)}::text::jsonb,
              ${p.scan.summary}, 'done',
              ${p.scan.effective === null ? null : JSON.stringify(p.scan.effective)}::text::jsonb,
              ${p.scan.createdAt})
      on conflict (id) do update set status = 'done', effective = excluded.effective`;
    // The cloud's score wins unless this computer scored it since (that score is on its way up).
    await sql`
      insert into pattern (id, scan_id, user_id, rank, rule, stats, status, decay_state,
                           decay_stats, last_scored)
      values (${p.id}, ${p.scan.id}, ${p.userId}, ${p.rank}, ${JSON.stringify(p.rule)}::text::jsonb,
              ${JSON.stringify(p.stats)}::text::jsonb, 'verified', ${p.decayState},
              ${p.decayStats === null ? null : JSON.stringify(p.decayStats)}::text::jsonb, ${p.lastScored})
      on conflict (id) do update set decay_state = excluded.decay_state,
        decay_stats = excluded.decay_stats, last_scored = excluded.last_scored
      where pattern.last_scored is null
         or (excluded.last_scored is not null and excluded.last_scored >= pattern.last_scored)
         or coalesce(excluded.decay_stats ? 'reverifyRequestedAt', false)`;
    await sql`
      insert into companion.decay_pulled (pattern_id, last_scored) values (${p.id}, ${p.lastScored})
      on conflict (pattern_id) do update set last_scored = excluded.last_scored`;
  }
  return patterns.length;
}

/** Sends up every decay score made here and not sent yet, with its fresh occurrences. */
export async function pushDecayScores(sql: postgres.Sql, client: CompanionClient): Promise<number> {
  const scored = await sql<
    {
      id: string;
      decay_state: string;
      decay_stats: Record<string, unknown>;
      last_scored: string;
      pulled: string | null;
      key: string;
    }[]
  >`
    select p.id::text, p.decay_state, p.decay_stats, p.last_scored::text, d.last_scored::text as pulled,
           'decay:' || p.id::text || ':' || p.last_scored::text || ':' || md5(p.decay_stats::text) as key
    from pattern p left join companion.decay_pulled d on d.pattern_id = p.id
    where p.status = 'verified' and p.decay_state is not null and p.last_scored is not null
      and p.decay_stats is not null
      and not exists (
        select 1 from companion.pushed x
        where x.client_key = 'decay:' || p.id::text || ':' || p.last_scored::text || ':' || md5(p.decay_stats::text))
    order by p.id`;
  for (const p of scored) {
    const occ = await sql<
      {
        instrument_id: string;
        as_of: string;
        hit: boolean;
        max_runup: number;
        max_drawdown: number;
        forward_return: number;
      }[]
    >`
      select instrument_id::text, as_of::text, hit, max_runup, max_drawdown, forward_return
      from pattern_occurrence
      where pattern_id = ${p.id} and "window" = 'fresh'
        and (${p.pulled}::date is null or as_of > ${p.pulled}::date - ${DECAY_RESEND_DAYS}::int)
      order by as_of, instrument_id`;
    const rows = occ.map(
      (o) =>
        [
          o.instrument_id,
          o.as_of,
          o.hit,
          Number(o.max_runup),
          Number(o.max_drawdown),
          Number(o.forward_return),
        ] as const,
    );
    // Parts first, then the state with the last part, so the cloud never shows a score ahead of its evidence.
    const parts = Math.max(1, Math.ceil(rows.length / DECAY_PART_SIZE));
    for (let i = 0; i < parts; i += 1) {
      const last = i === parts - 1;
      await pushOnce(sql, client, 'pattern_decay', last ? p.key : `${p.key}:p${i}`, {
        patternId: p.id,
        occurrences: rows.slice(i * DECAY_PART_SIZE, (i + 1) * DECAY_PART_SIZE),
        ...(last
          ? {
              state: {
                decayState: p.decay_state,
                decayStats: p.decay_stats,
                lastScored: p.last_scored,
              },
            }
          : {}),
      });
    }
  }
  return scored.length;
}

export async function mineOnce(
  sql: postgres.Sql,
  storeUrl: string,
  client: CompanionClient,
  cloud: CloudData,
  miner: MinerRunner,
  today: string = new Date().toISOString().slice(0, 10),
): Promise<MiningResult> {
  let pushed = await pushFinishedScans(sql, client);
  let decayPushed = await pushDecayScores(sql, client);
  // A scan the miner was running when the companion stopped goes back in its queue.
  await sql`update pattern_scan set status = 'queued' where status = 'running'`;
  const [waiting] = await sql<{ id: string }[]>`
    select id::text from pattern_scan where status = 'queued' order by created_at limit 1`;
  let claimed: string | null = waiting?.id ?? null;
  if (!claimed) {
    const { scan } = await cloud.ask<PatternScanAnswer>('pattern_scan', {});
    if (scan) {
      const [had] = await sql<LocalScan[]>`
        select id::text, status, error, candidates_tested, finalists, verified, effective,
               code_version, seconds
        from pattern_scan where id = ${scan.id} and status in ('done', 'failed')`;
      if (had) {
        // The cloud put a scan finished here back in its queue (ADR 0121): send the result again.
        await pushScan(sql, client, had, `scan:${scan.id}:again:${Date.now()}`);
        pushed += 1;
      } else {
        await sql`
          insert into pattern_scan (id, user_id, config, summary, status, created_at)
          values (${scan.id}, ${scan.userId}, ${JSON.stringify(scan.config)}::text::jsonb, ${scan.summary},
                  'queued', ${scan.createdAt})
          on conflict (id) do nothing`;
        claimed = scan.id;
      }
    }
  }
  const decayDue = await pullDecayDue(sql, cloud, today);
  if (!claimed && decayDue === 0) return { claimed, pushed, decayDue, decayPushed };
  const run = await miner(storeUrl);
  if (run.code !== 0) {
    throw new Error(`The pattern miner stopped: ${run.tail.at(-1) ?? `exit ${run.code}`}`);
  }
  pushed += await pushFinishedScans(sql, client);
  decayPushed += await pushDecayScores(sql, client);
  return { claimed, pushed, decayDue, decayPushed };
}
