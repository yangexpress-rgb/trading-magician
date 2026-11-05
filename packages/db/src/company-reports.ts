import { isFundamentalsProvider, type CompanyReport } from '@tm/domain';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { IntegrationError } from './feeds';
import { companyReports, dataFeedConnections } from './schema';

/**
 * Company pages for Quantitative Research (ADR 0031). Financials come from
 * the tenant's company data feed, whose contact or key only the worker can
 * open, so the web app queues a report and polls it; the worker stores the
 * profile, five fiscal years and recent filings on the row.
 */

export type CompanyReportStatus = 'pending' | 'ready' | 'failed';

export interface CompanyReportSummary {
  id: string;
  symbol: string;
  status: CompanyReportStatus;
  message: string | null;
  source: string | null;
  report: CompanyReport | null;
  createdAt: string;
  updatedAt: string;
}

/** A ready report this recent is shown again instead of asking the feed: filings change slowly. */
export const COMPANY_REUSE_SECONDS = 12 * 3600;
const MAX_PENDING = 5;

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

export interface FundamentalsFeedRow {
  id: string;
  name: string;
  provider: string;
  credentialRef: string | null;
}

/** The company data feed in use: the oldest one that is on. */
export async function activeFundamentalsFeed(
  tx: Transaction,
): Promise<FundamentalsFeedRow | undefined> {
  const feeds = await tx
    .select({
      id: dataFeedConnections.id,
      name: dataFeedConnections.name,
      provider: dataFeedConnections.provider,
      credentialRef: dataFeedConnections.credentialRef,
    })
    .from(dataFeedConnections)
    .where(eq(dataFeedConnections.isActive, true))
    .orderBy(asc(dataFeedConnections.createdAt));
  return feeds.find((f) => isFundamentalsProvider(f.provider));
}

/** Starts a report, or hands back the one in progress or from the last 12 hours. */
export async function requestCompanyReport(
  tx: Transaction,
  input: { userId: string; symbol: string; fresh?: boolean | undefined },
): Promise<CompanyReportSummary> {
  const symbol = input.symbol.trim().toUpperCase().replace(/-/g, '.');
  if (!SYMBOL.test(symbol)) throw new IntegrationError('bad_request', 'That is not a US ticker');
  if (!(await activeFundamentalsFeed(tx))) {
    throw new IntegrationError(
      'invalid_state',
      'Add a company data feed under Settings › Data feeds to see company financials.',
    );
  }
  const [recent] = await tx
    .select({ id: companyReports.id })
    .from(companyReports)
    .where(
      and(
        eq(companyReports.symbol, symbol),
        input.fresh
          ? eq(companyReports.status, 'pending')
          : sql`(${companyReports.status} = 'pending' OR (${companyReports.status} = 'ready' AND ${companyReports.createdAt} > now() - make_interval(secs => ${COMPANY_REUSE_SECONDS})))`,
      ),
    )
    .orderBy(desc(companyReports.createdAt))
    .limit(1);
  if (recent) return getCompanyReport(tx, recent.id);
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(companyReports)
    .where(
      and(
        eq(companyReports.status, 'pending'),
        sql`${companyReports.createdAt} > now() - interval '1 hour'`,
      ),
    );
  if ((pending?.n ?? 0) >= MAX_PENDING) {
    throw new IntegrationError('conflict', 'Wait for your other company pages to load');
  }
  const [row] = await tx
    .insert(companyReports)
    .values({ userId: input.userId, symbol })
    .returning({ id: companyReports.id });
  if (!row) throw new Error('company report insert failed');
  return getCompanyReport(tx, row.id);
}

export async function getCompanyReport(tx: Transaction, id: string): Promise<CompanyReportSummary> {
  const [row] = await tx.select().from(companyReports).where(eq(companyReports.id, id));
  if (!row) throw new IntegrationError('not_found', 'No such company page');
  return {
    id: row.id,
    symbol: row.symbol,
    status: row.status,
    message: row.message,
    source: row.source,
    report: (row.report as CompanyReport | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// --- Worker side -------------------------------------------------------------

export async function claimCompanyReports(
  db: Database,
  options: { leaseSeconds: number; limit: number },
): Promise<{ reportId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_company_reports(${options.leaseSeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ reportId: r.claimed_id, userId: r.claimed_user }));
}

export async function loadPendingCompanyReport(tx: Transaction, id: string) {
  const [row] = await tx
    .select({
      id: companyReports.id,
      symbol: companyReports.symbol,
      attempts: companyReports.attempts,
    })
    .from(companyReports)
    .where(and(eq(companyReports.id, id), eq(companyReports.status, 'pending')));
  return row;
}

export async function finishCompanyReport(
  tx: Transaction,
  id: string,
  outcome:
    | { status: 'ready'; report: CompanyReport; source: string }
    | { status: 'failed'; message: string; source?: string | undefined }
    | { status: 'retry' },
): Promise<void> {
  // A retry keeps its lease, which then lapses and lets the report be claimed again.
  if (outcome.status === 'retry') return;
  await tx
    .update(companyReports)
    .set(
      outcome.status === 'ready'
        ? {
            status: 'ready',
            report: outcome.report,
            source: outcome.source.slice(0, 100),
            message: null,
          }
        : {
            status: 'failed',
            message: outcome.message.slice(0, 200),
            source: outcome.source?.slice(0, 100) ?? null,
          },
    )
    .where(and(eq(companyReports.id, id), eq(companyReports.status, 'pending')));
}
