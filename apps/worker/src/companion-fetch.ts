import {
  answerCompanionFetches,
  claimPatternScan,
  clearStaleCompanionFetches,
  encodeBars,
  encodeEvents,
  instrumentRefs,
  loadEventData,
  loadOptionSignals,
  type Database,
  type FetchAnswerer,
  type FetchAnswers,
} from '@tm/db';
import type { HistoricalDataProvider } from '@tm/domain';
import type { Logger } from 'pino';
import type { FundamentalsLoader } from './fundamentals';

/**
 * Answers the Local Companion's data requests (ADR 0118): members, daily
 * bars, filings and earnings, through the same functions the cloud's ML
 * snapshot job calls, so what the companion computes equals the cloud's. Bars
 * come through the person's feeds (or the sharing admin's, N237) on the
 * background budget, like every research job. A quiet pass is one indexed read.
 */

export interface CompanionFetchDeps {
  db: Database;
  /** The Research Store, where pattern scans queue (ADR 0120); defaults to `db`. */
  research?: Database;
  /** Bars for a user, through their routes (createMemberHistory, patient and in the background). */
  history: (userId: string) => HistoricalDataProvider;
  fundamentals: FundamentalsLoader;
  /** A model universe's members today, as the ML snapshot job resolves them. */
  members: (universe: string) => Promise<string[]>;
  /** The factor store's members, as the pattern snapshot job resolves them (ADR 0119). */
  patternMembers: () => Promise<{ members: string[]; sessionMembers: string[]; from: string }>;
}

export function companionFetchAnswerer(deps: CompanionFetchDeps): FetchAnswerer {
  const answer = async (kind: string, request: unknown, userId: string): Promise<unknown> => {
    switch (kind) {
      case 'members': {
        const { universe } = request as { universe: string };
        const ids = [...new Set(await deps.members(universe))].sort();
        const refs = await deps.db.transaction((tx) => instrumentRefs(tx, ids));
        return { ids, refs: [...refs] } satisfies FetchAnswers['members'];
      }
      case 'bars': {
        const { requests } = request as {
          requests: Parameters<HistoricalDataProvider['getBars']>[0][];
        };
        const history = deps.history(userId);
        const results = history.getBarsMany
          ? await history.getBarsMany(requests)
          : await Promise.all(
              requests.map((r) =>
                history
                  .getBars(r)
                  .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
              ),
            );
        return encodeBars(results);
      }
      case 'filings': {
        const { instruments } = request as { instruments: { id: string; symbol: string }[] };
        const filings = await deps.fundamentals(userId, instruments, { perSymbolWarnings: false });
        return { byId: [...filings.byId] } satisfies FetchAnswers['filings'];
      }
      case 'events': {
        const { ids, metrics } = request as { ids: string[]; metrics?: string[] };
        const reads = new Set(metrics ?? ['earnings.sue_ts']);
        const data = await loadEventData(deps.db, new Map(ids.map((id) => [id, reads])));
        return encodeEvents(data);
      }
      case 'pattern_members': {
        const found = await deps.patternMembers();
        const members = [...new Set(found.members)].sort();
        const refs = await deps.db.transaction((tx) => instrumentRefs(tx, members));
        return {
          members,
          sessionMembers: found.sessionMembers,
          refs: [...refs],
          from: found.from,
        } satisfies FetchAnswers['pattern_members'];
      }
      case 'option_signals': {
        const { ids, from } = request as { ids: string[]; from: string };
        return {
          byId: [...(await loadOptionSignals(deps.db, ids, from))],
        } satisfies FetchAnswers['option_signals'];
      }
      case 'pattern_scan':
        return claimPatternScan(deps.research ?? deps.db);
      default:
        throw new Error(`Unknown request kind ${kind}`);
    }
  };
  return answer as FetchAnswerer;
}

export interface CompanionFetchLoop {
  stop(): Promise<void>;
}

export function startCompanionFetchLoop(
  options: CompanionFetchDeps & {
    logger: Pick<Logger, 'info' | 'warn' | 'error'>;
    pollMs?: number;
  },
): CompanionFetchLoop {
  const pollMs = options.pollMs ?? 3_000;
  const answer = companionFetchAnswerer(options);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let lastClear = 0;

  const pass = async () => {
    try {
      for (const a of await answerCompanionFetches({ core: options.db, answer })) {
        if (a.error)
          options.logger.warn(
            { fetch: a.id, kind: a.kind, error: a.error },
            'companion request failed',
          );
      }
      if (Date.now() - lastClear > 600_000) {
        lastClear = Date.now();
        await clearStaleCompanionFetches(options.db);
      }
    } catch (err) {
      options.logger.error({ err }, 'companion request pass failed');
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      running = pass().finally(schedule);
    }, pollMs);
  };
  running = pass().finally(schedule);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
