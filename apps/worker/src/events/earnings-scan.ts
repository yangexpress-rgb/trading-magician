import {
  calendarEstimateNear,
  releasesAwaitingSue,
  saveEarningsRelease,
  saveSue,
  setReleaseEstimate,
  setScanState,
  storedReleaseAccessions,
  strategyStockSymbols,
  updateReleaseEps,
  type Database,
  type EventJob,
} from '@tm/db';
import {
  addDays,
  nyDate,
  releaseQuarterEnd,
  SP500_SECTORS,
  surprisePct,
  type EarningsSource,
} from '@tm/domain';
import {
  announcedDateOf,
  earningsReleaseFilings,
  fetchCompanyFacts,
  fetchFilings,
  quarterlyEps,
  releaseSue,
  SecNotFoundError,
  type SecClient,
  type SecCompanyFacts,
  type SecListing,
} from '@tm/sec';
import type { Logger } from 'pino';

/**
 * The earnings release scan (free data feeds brief v1 §5.2, ADR 0058): for
 * the S&P 500 and every stock a saved strategy uses, the 8-Ks with Item 2.02
 * since `fromDate` become release rows, each with its time-series SUE from
 * the company's point-in-time quarterly EPS. The same scan from February
 * 2024 is the one-off history rebuild (`source = 'rebuilt'`).
 */

export interface EarningsScanOptions {
  db: Database;
  client: SecClient;
  tickers: () => Promise<Map<string, SecListing>>;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  /** Tests only: the symbols to scan instead of the S&P 500 and strategy stocks. */
  symbols?: readonly string[];
}

/** Releases this recent whose EPS isn't on EDGAR yet are looked at again each day. */
const PENDING_DAYS = 120;

/** The scan's universe: S&P 500 members plus stocks saved strategies use. */
export async function earningsUniverse(o: EarningsScanOptions): Promise<string[]> {
  if (o.symbols) return [...o.symbols];
  const fromStrategies = await strategyStockSymbols(o.db);
  return [...new Set([...SP500_SECTORS.keys(), ...fromStrategies])].sort();
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 200);

async function factsOf(client: SecClient, cik: string): Promise<SecCompanyFacts | null> {
  try {
    return await fetchCompanyFacts(client, cik);
  } catch (e) {
    if (e instanceof SecNotFoundError) return null;
    throw e;
  }
}

/** Stores one company's new releases since `fromDate`; returns how many were added. */
export async function scanCompany(
  o: EarningsScanOptions,
  listing: SecListing,
  fromDate: string,
  source: EarningsSource,
): Promise<number> {
  const { filings } = await fetchFilings(o.client, listing.cik, fromDate);
  const stored = await storedReleaseAccessions(o.db, listing.ticker);
  const fresh = earningsReleaseFilings(filings).filter((f) => !stored.has(f.accession));
  if (fresh.length === 0) return 0;
  const facts = await factsOf(o.client, listing.cik);
  const knownEnds = facts ? quarterlyEps(facts).map((q) => q.quarterEnd) : [];
  let added = 0;
  for (const f of fresh) {
    const fiscalQuarterEnd = releaseQuarterEnd(knownEnds, f.filingDate);
    if (!fiscalQuarterEnd) continue; // no quarterly figures to place it against
    const sue = facts ? releaseSue(facts, fiscalQuarterEnd) : undefined;
    const ok = await saveEarningsRelease(o.db, {
      symbol: listing.ticker,
      cik: listing.cik,
      fiscalQuarterEnd,
      announcedAt: f.acceptedAt,
      announcedDate: announcedDateOf(f.acceptedAt),
      timeKnown: f.timeKnown,
      reportedEps: sue?.eps ?? null,
      accession: f.accession,
      filingUrl: f.url,
    });
    if (!ok) continue;
    added++;
    if (sue?.result)
      await saveSue(o.db, {
        symbol: listing.ticker,
        fiscalQuarterEnd,
        announcedAt: f.acceptedAt,
        epsQ: sue.result.epsQ,
        epsQMinus4: sue.result.epsQMinus4,
        diffSd: sue.result.diffSd,
        sue: sue.result.sue,
        source,
      });
  }
  return added;
}

/**
 * Fills releases whose quarter's EPS has since reached EDGAR (the 10-Q often
 * follows the 8-K by days or weeks) and adds a calendar estimate's surprise.
 */
export async function completePendingReleases(o: EarningsScanOptions): Promise<number> {
  const today = nyDate((o.now ?? (() => new Date()))());
  const pending = await releasesAwaitingSue(o.db, addDays(today, -PENDING_DAYS));
  const byCik = new Map<string, typeof pending>();
  for (const r of pending) byCik.set(r.cik, [...(byCik.get(r.cik) ?? []), r]);
  let done = 0;
  for (const [cik, releases] of byCik) {
    let facts: SecCompanyFacts | null;
    try {
      facts = await factsOf(o.client, cik);
    } catch (e) {
      o.logger.warn({ cik, err: shortError(e) }, 'company facts unavailable');
      continue;
    }
    if (!facts) continue;
    for (const r of releases) {
      const sue = releaseSue(facts, r.fiscalQuarterEnd);
      if (!sue) continue;
      const estimate = await calendarEstimateNear(o.db, r.symbol, r.announcedDate);
      await updateReleaseEps(
        o.db,
        r.id,
        sue.eps,
        surprisePct(sue.eps, estimate?.eps ?? r.estimatedEps),
      );
      if (estimate)
        await setReleaseEstimate(
          o.db,
          r.id,
          estimate.eps,
          estimate.provider,
          surprisePct(sue.eps, estimate.eps),
        );
      if (!sue.result) continue;
      await saveSue(o.db, {
        symbol: r.symbol,
        fiscalQuarterEnd: r.fiscalQuarterEnd,
        announcedAt: r.announcedAt.toISOString(),
        epsQ: sue.result.epsQ,
        epsQMinus4: sue.result.epsQMinus4,
        diffSd: sue.result.diffSd,
        sue: sue.result.sue,
        source: 'recorded',
      });
      done++;
    }
  }
  return done;
}

/**
 * One pass of the scan over the universe from `fromDate`: each company's
 * failure is logged and counted, never fatal. Progress is kept in the job's
 * state so Research can say how far the record goes.
 */
export async function runEarningsScan(
  o: EarningsScanOptions,
  job: Extract<EventJob, 'earnings_scan' | 'earnings_rebuild'>,
  fromDate: string,
): Promise<{ companies: number; added: number; failed: number; missing: number }> {
  const now = (o.now ?? (() => new Date()))();
  await setScanState(o.db, job, { status: 'running', lastRunAt: now });
  const source: EarningsSource = job === 'earnings_rebuild' ? 'rebuilt' : 'recorded';
  let added = 0;
  let failed = 0;
  let missing = 0;
  let tickers: Map<string, SecListing>;
  try {
    tickers = await o.tickers();
  } catch (e) {
    await setScanState(o.db, job, { status: 'failed', lastError: shortError(e) });
    throw e;
  }
  const symbols = await earningsUniverse(o);
  for (const symbol of symbols) {
    const listing = tickers.get(symbol);
    if (!listing) {
      missing++;
      continue;
    }
    try {
      added += await scanCompany(o, listing, fromDate, source);
    } catch (e) {
      failed++;
      o.logger.warn({ symbol, err: shortError(e) }, 'earnings scan failed for a company');
    }
  }
  const completed = job === 'earnings_scan' ? await completePendingReleases(o) : 0;
  const today = nyDate(now);
  await setScanState(o.db, job, {
    status: failed === symbols.length && symbols.length > 0 ? 'failed' : 'done',
    coveredFrom: fromDate,
    coveredTo: today,
    lastOkAt: new Date(),
    lastError: failed > 0 ? `${failed} of ${symbols.length} companies could not be read` : null,
    note: `${added} new releases; ${completed} completed; ${missing} symbols not on EDGAR`,
  });
  o.logger.info({ job, added, failed, missing, completed }, 'earnings scan finished');
  return { companies: symbols.length, added, failed, missing };
}
