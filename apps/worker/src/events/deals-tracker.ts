import {
  changeDealStatus,
  dealAccessionKnown,
  dealsToCheck,
  findDeal,
  improveDeal,
  insertDeal,
  markDealChecked,
  setScanState,
  type Database,
} from '@tm/db';
import { addDays, nyDate } from '@tm/domain';
import {
  DEAL_SEARCHES,
  dealFilingHit,
  fetchFilings,
  filedDateAvailability,
  filingText,
  looksLikeMerger,
  nameKey,
  parseMergerFiling,
  searchFilings,
  statusChanges,
  terminatesMerger,
  type DealFilingHit,
  type SecClient,
  type SecListing,
  type SecSearchHit,
} from '@tm/sec';
import type { Logger } from 'pino';

/**
 * The merger-deal tracker (free data feeds brief v1 D3, §5.3, ADR 0058). Each
 * day after the close it searches EDGAR for new merger agreements (8-K Item
 * 1.01) and tender-offer recommendations (Schedule 14D-9), parses each into a
 * deal, and re-reads every active deal's target filings for a status change.
 * The same search month by month from February 2024 is the history rebuild.
 */

export interface DealTrackerOptions {
  db: Database;
  client: SecClient;
  tickers: () => Promise<Map<string, SecListing>>;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

const shortError = (e: unknown) =>
  (e instanceof Error ? e.message : 'failed').replace(/\s+/g, ' ').slice(0, 200);

/** One hit per filing: the primary document, not its exhibits. */
export function primaryHits(hits: readonly SecSearchHit[]): DealFilingHit[] {
  const out = new Map<string, DealFilingHit>();
  for (const hit of hits) {
    const h = dealFilingHit(hit);
    if (!h) continue;
    const primary = !hit._source.file_type || hit._source.file_type === hit._source.form;
    if (!primary && out.has(h.accession)) continue;
    if (primary || !out.has(h.accession)) out.set(h.accession, h);
  }
  return [...out.values()].sort(
    (a, b) => a.filedDate.localeCompare(b.filedDate) || a.accession.localeCompare(b.accession),
  );
}

export type HitOutcome = 'added' | 'improved' | 'known' | 'skipped';

/** Reads one announcing filing and records or improves its deal. */
export async function processDealHit(
  o: DealTrackerOptions,
  h: DealFilingHit,
  source: 'rebuilt' | 'recorded',
  byName: Map<string, SecListing>,
  byCik: Map<string, SecListing>,
): Promise<HitOutcome> {
  if (h.form === '8-K' && !h.items.includes('1.01')) return 'skipped';
  if (await dealAccessionKnown(o.db, h.accession)) return 'known';
  const text = filingText(await o.client.document(h.documentPath));
  if (!looksLikeMerger(text)) return 'skipped';
  const parsed = parseMergerFiling(text);
  // The subject company files the Schedule 14D-9: the filer is the target.
  const role = h.form === 'SC 14D9' ? 'target' : parsed.role;
  let target: { name: string; cik: string | null; symbol: string | null };
  let acquirerName = parsed.acquirerName;
  const notes = [...parsed.notes];
  if (role === 'target') {
    const listing = byCik.get(h.filer.cik);
    target = {
      name: h.filer.name,
      cik: h.filer.cik,
      symbol: h.filer.tickers[0] ?? listing?.ticker ?? null,
    };
  } else if (role === 'acquirer' && parsed.targetName) {
    const listing = byName.get(nameKey(parsed.targetName));
    target = {
      name: parsed.targetName,
      cik: listing ? String(Number(listing.cik)) : null,
      symbol: listing?.ticker ?? null,
    };
    acquirerName = h.filer.name;
    notes.push(
      listing
        ? "target matched to a listing by name from the acquirer's filing"
        : 'target not listed, or not matched to a listing',
    );
  } else return 'skipped';
  const confidence = role === 'target' && h.form === '8-K' ? parsed.confidence : 'low';
  const consideration = parsed.consideration;
  const offerPrice = consideration === 'cash' ? parsed.offerPrice : null;
  const existing = await findDeal(o.db, {
    accession: h.accession,
    targetCik: target.cik,
    targetName: target.name,
    date: h.filedDate,
  });
  if (existing) {
    // The target's own filing pins down what an acquirer's left open.
    if (existing.confidence === 'low' && confidence === 'high') {
      await improveDeal(o.db, existing.dealId, {
        targetSymbol: target.symbol,
        targetCik: target.cik,
        acquirerName,
        offerPrice,
        consideration,
        confidence,
        parseNote: notes.join('; ') || null,
      });
      return 'improved';
    }
    return 'known';
  }
  await insertDeal(o.db, {
    targetSymbol: target.symbol,
    targetCik: target.cik,
    targetName: target.name,
    acquirerName,
    announcedDate: h.filedDate,
    announcedAt: filedDateAvailability(h.filedDate),
    offerPrice,
    consideration,
    sourceFilingUrl: `${o.client.wwwUrl}${h.documentPath}`,
    accession: h.accession,
    confidence,
    parseNote: notes.join('; ') || null,
    source,
  });
  return 'added';
}

/** Month windows from `from` to `to`, oldest first, so deal ids follow announcement order. */
export function monthWindows(from: string, to: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  let start = from;
  while (start <= to) {
    const [y, m] = start.split('-').map(Number) as [number, number];
    const monthEnd = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const end = monthEnd < to ? monthEnd : to;
    out.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return out;
}

/** Searches EDGAR for deals filed from `from` to `to` and records them. */
export async function scanDeals(
  o: DealTrackerOptions,
  job: 'deals_scan' | 'deals_rebuild',
  from: string,
  to: string,
) {
  const now = (o.now ?? (() => new Date()))();
  await setScanState(o.db, job, { status: 'running', lastRunAt: now });
  const tickers = await o.tickers();
  const byName = new Map<string, SecListing>();
  const byCik = new Map<string, SecListing>();
  for (const l of tickers.values()) {
    const key = nameKey(l.name);
    if (!byName.has(key)) byName.set(key, l);
    const cik = String(Number(l.cik));
    if (!byCik.has(cik)) byCik.set(cik, l);
  }
  const counts: Record<HitOutcome | 'failed', number> = {
    added: 0,
    improved: 0,
    known: 0,
    skipped: 0,
    failed: 0,
  };
  const source = job === 'deals_rebuild' ? 'rebuilt' : 'recorded';
  for (const w of monthWindows(from, to)) {
    const hits: SecSearchHit[] = [];
    for (const s of DEAL_SEARCHES) hits.push(...(await searchFilings(o.client, { ...s, ...w })));
    for (const h of primaryHits(hits)) {
      try {
        counts[await processDealHit(o, h, source, byName, byCik)]++;
      } catch (e) {
        counts.failed++;
        o.logger.warn({ accession: h.accession, err: shortError(e) }, 'deal filing unreadable');
      }
    }
    // Progress per month, so a restarted rebuild picks up where it stopped.
    await setScanState(o.db, job, { coveredFrom: from, coveredTo: w.to });
  }
  await setScanState(o.db, job, {
    status: 'done',
    coveredFrom: from,
    coveredTo: to,
    lastOkAt: new Date(),
    lastError: counts.failed > 0 ? `${counts.failed} filings could not be read` : null,
    note: `${counts.added} new deals, ${counts.improved} improved, ${counts.skipped} filings not deals`,
  });
  o.logger.info({ job, ...counts }, 'deal scan finished');
  return counts;
}

/**
 * Re-reads each active deal's target filings since its announcement and
 * applies the status changes they imply, in filing order (§5.3).
 */
export async function updateDealStatuses(o: DealTrackerOptions, limit = 200) {
  const now = (o.now ?? (() => new Date()))();
  let changed = 0;
  for (const deal of await dealsToCheck(o.db, limit)) {
    if (!deal.targetCik) continue;
    try {
      const { filings } = await fetchFilings(o.client, deal.targetCik, deal.announcedDate);
      for (const c of statusChanges(filings, deal.accession, deal.announcedAt)) {
        if (
          c.needsText &&
          !terminatesMerger(filingText(await o.client.document(new URL(c.filing.url).pathname)))
        )
          continue;
        const ok = await changeDealStatus(o.db, {
          dealId: deal.dealId,
          newStatus: c.status,
          changedAt: c.filing.acceptedAt,
          changedDate: nyDate(new Date(c.filing.acceptedAt)),
          sourceFilingUrl: c.filing.url,
          accession: c.filing.accession,
        });
        if (ok) changed++;
        if (c.status === 'closed' || c.status === 'withdrawn') break;
      }
      await markDealChecked(o.db, deal.dealId, now);
    } catch (e) {
      o.logger.warn({ dealId: deal.dealId, err: shortError(e) }, 'deal status check failed');
    }
  }
  return changed;
}
