import type { PatternScanAnswer } from '@tm/db';
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
 */

export type MinerRunner = (storeUrl: string) => Promise<RunResult>;

export interface MiningResult {
  claimed: string | null;
  pushed: number;
}

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
  for (const scan of scans) {
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
    await pushOnce(sql, client, 'pattern_scan_result', `scan:${scan.id}`, {
      scan: {
        id: scan.id,
        status: scan.status,
        error: scan.error,
        candidatesTested: scan.candidates_tested,
        finalists: scan.finalists,
        verified: scan.verified,
        effective: scan.effective,
        codeVersion: scan.code_version,
        seconds: scan.seconds === null ? null : Number(scan.seconds),
      },
      patterns: withOccurrences,
    });
  }
  return scans.length;
}

export async function mineOnce(
  sql: postgres.Sql,
  storeUrl: string,
  client: CompanionClient,
  cloud: CloudData,
  miner: MinerRunner,
): Promise<MiningResult> {
  let pushed = await pushFinishedScans(sql, client);
  // A scan the miner was running when the companion stopped goes back in its queue.
  await sql`update pattern_scan set status = 'queued' where status = 'running'`;
  const [waiting] = await sql<{ id: string }[]>`
    select id::text from pattern_scan where status = 'queued' order by created_at limit 1`;
  let claimed: string | null = waiting?.id ?? null;
  if (!claimed) {
    const { scan } = await cloud.ask<PatternScanAnswer>('pattern_scan', {});
    if (!scan) return { claimed: null, pushed };
    await sql`
      insert into pattern_scan (id, user_id, config, summary, status, created_at)
      values (${scan.id}, ${scan.userId}, ${JSON.stringify(scan.config)}::jsonb, ${scan.summary},
              'queued', ${scan.createdAt})
      on conflict (id) do nothing`;
    claimed = scan.id;
  }
  const run = await miner(storeUrl);
  if (run.code !== 0) {
    throw new Error(`The pattern miner stopped: ${run.tail.at(-1) ?? `exit ${run.code}`}`);
  }
  pushed += await pushFinishedScans(sql, client);
  return { claimed, pushed };
}
