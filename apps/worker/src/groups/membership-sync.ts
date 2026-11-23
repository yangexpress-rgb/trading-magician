import {
  membershipCoverageByYear,
  syncMembershipPeriods,
  type Database,
  type MembershipSyncResult,
  type MembershipYear,
  type StoredMembershipPeriod,
} from '@tm/db';
import {
  currentSymbolFor,
  SP500_HISTORY_SOURCE,
  SP500_PERIODS,
  SP500_PERIODS_THROUGH,
  type MembershipPeriod,
} from '@tm/domain';
import type { Logger } from 'pino';

/**
 * Stores the imported S&P 500 history (data inputs part 2, item C, N324,
 * ADR 0112) in group_membership_period and reports what it stored. Runs when
 * the worker starts and once a day; running it again changes nothing unless
 * the file was re-imported or a symbol has since become resolvable. Each
 * period resolves through the symbol its company trades under now (FB and
 * META are one instrument); a period that ended before the price feed's
 * history begins, or whose symbol no feed lists, is stored without an
 * instrument.
 */

export interface MembershipReport extends MembershipSyncResult {
  group: string;
  through: string;
  periods: number;
  /** Periods stored without an instrument because they ended before the feed's history. */
  beforeBars: number;
  /** Symbols (as the file writes them) of periods inside the feed's history that matched nothing. */
  unresolved: string[];
  byYear: MembershipYear[];
}

export async function syncSp500Membership(options: {
  db: Database;
  /** Instruments for symbols, registering the ones the feed lists. */
  resolve: (symbols: readonly string[]) => Promise<Map<string, string>>;
  /** The first day the price feed has bars for; earlier periods have none. */
  barsFrom: string;
  now: () => Date;
  logger: Pick<Logger, 'info' | 'warn'>;
  periods?: readonly MembershipPeriod[];
}): Promise<MembershipReport> {
  const periods = options.periods ?? SP500_PERIODS;
  const inBars = (p: MembershipPeriod) => p.to === null || p.to > options.barsFrom;
  const targets = new Map<MembershipPeriod, string | undefined>();
  for (const p of periods) targets.set(p, inBars(p) ? currentSymbolFor(p) : undefined);
  const wanted = [...new Set([...targets.values()].filter((s): s is string => !!s))].sort();
  const ids = await options.resolve(wanted);
  const rows: StoredMembershipPeriod[] = periods.map((p) => {
    const target = targets.get(p);
    return {
      symbol: p.symbol,
      from: p.from,
      to: p.to,
      instrumentId: (target && ids.get(target)) ?? null,
    };
  });
  const sync = await syncMembershipPeriods(options.db, {
    groupId: 'sp500',
    source: SP500_HISTORY_SOURCE,
    periods: rows,
  });
  const unresolved = [
    ...new Set(rows.filter((r, i) => !r.instrumentId && inBars(periods[i]!)).map((r) => r.symbol)),
  ].sort();
  const year = Number(options.barsFrom.slice(0, 4));
  const report: MembershipReport = {
    group: 'sp500',
    through: SP500_PERIODS_THROUGH,
    ...sync,
    periods: rows.length,
    beforeBars: periods.filter((p) => !inBars(p)).length,
    unresolved,
    byYear: await membershipCoverageByYear(
      options.db,
      'sp500',
      year,
      options.now().getUTCFullYear(),
    ),
  };
  options.logger.info(
    {
      group: report.group,
      through: report.through,
      periods: report.periods,
      inserted: report.inserted,
      updated: report.updated,
      deleted: report.deleted,
      unchanged: report.unchanged,
      beforeBars: report.beforeBars,
      unresolvedCount: report.unresolved.length,
      unresolved: report.unresolved,
      byYear: report.byYear,
    },
    'group membership stored',
  );
  return report;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Runs the sync now and then daily, so symbols a feed lists later resolve.
 * A failure is logged and retried at the next run; it never stops the worker.
 */
export function startMembershipSync(
  options: Parameters<typeof syncSp500Membership>[0] & { everyMs?: number },
): { stop: () => void; done: Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const run = async () => {
    try {
      await syncSp500Membership(options);
    } catch (error) {
      options.logger.warn({ err: error }, 'group membership not stored; trying again tomorrow');
    }
    if (!stopped) timer = setTimeout(() => void run(), options.everyMs ?? DAY_MS);
  };
  const done = run();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    done,
  };
}
