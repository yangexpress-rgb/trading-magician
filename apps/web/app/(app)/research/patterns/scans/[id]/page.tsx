import { getPatternScan, listPatterns, withTenant } from '@tm/db';
import { FACTOR_CATEGORY_LABELS, outcomeWords, type FactorCategory } from '@tm/domain';
import { Alert, Card, DataValue, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PatternTable } from '@/components/patterns/pattern-table';
import { ResearchNav } from '@/components/research/research-nav';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Pattern scan · Quantitative Research' };
export const dynamic = 'force-dynamic';

interface Effective {
  from?: string;
  to?: string;
  discoveryEnd?: string;
  holdoutStart?: string;
  excludedCategories?: string[];
  discoveryBaseRate?: number;
  holdoutBaseRate?: number;
  atoms?: number;
  suppressed?: number;
  instruments?: number;
}

const pct = (v: number | undefined) => (v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const n = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString('en-US');

/** One scan (brief §6, §8): what it searched, over which days, and its finalists. */
export default async function PatternScanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const tenant = await requireTenant();
  const { scan, rows } = await withTenant(appDb(), tenant, async (tx) => {
    const scan = await getPatternScan(tx, id);
    return { scan, rows: scan ? await listPatterns(tx, id) : [] };
  });
  if (!scan) notFound();
  const eff = (scan.effective ?? {}) as Effective;
  const verified = rows.filter((r) => r.status === 'verified');
  const candidates = rows.filter((r) => r.status !== 'verified');
  return (
    <>
      <PageHeader title="Quantitative Research" description={scan.summary} />
      <ResearchNav />
      <div className="space-y-6">
        <p className="text-sm">
          <Link href="/research/patterns" className="text-accent hover:underline">
            ← All scans
          </Link>
        </p>
        <Card>
          <section aria-labelledby="scan-heading" className="space-y-4">
            <h2 id="scan-heading" className="text-lg font-semibold">
              Scan
            </h2>
            <p className="text-sm">
              Looks for days after which a stock {outcomeWords(scan.config.outcome)}.
            </p>
            {scan.status === 'queued' && (
              <p className="text-sm text-ink-muted">
                Queued: it runs with the miner&rsquo;s next batch run.
              </p>
            )}
            {scan.status === 'running' && <p className="text-sm text-ink-muted">Running now.</p>}
            {scan.status === 'failed' && <Alert>The scan failed: {scan.error}</Alert>}
            {scan.status === 'done' && (
              <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
                <DataValue label="Rules tested" value={n(scan.candidatesTested)} primary />
                <DataValue label="Finalists" value={n(scan.finalists)} />
                <DataValue label="Verified" value={n(scan.verified)} primary />
                <DataValue label="Instruments" value={n(eff.instruments)} />
                <DataValue label="Atoms" value={n(eff.atoms)} />
                <DataValue
                  label="Run time"
                  value={scan.seconds === null ? '—' : `${scan.seconds} s`}
                />
                <DataValue
                  label="Discovery"
                  value={`${eff.from ?? '—'} to ${eff.discoveryEnd ?? '—'}`}
                />
                <DataValue
                  label="Holdout"
                  value={`${eff.holdoutStart ?? '—'} to ${eff.to ?? '—'}`}
                />
                <DataValue label="Discovery base rate" value={pct(eff.discoveryBaseRate)} />
                <DataValue label="Holdout base rate" value={pct(eff.holdoutBaseRate)} />
              </div>
            )}
            {eff.excludedCategories && eff.excludedCategories.length > 0 && (
              <p className="text-sm text-ink-muted">
                Left out for lack of data:{' '}
                {eff.excludedCategories
                  .map((c) => FACTOR_CATEGORY_LABELS[c as FactorCategory] ?? c)
                  .join(', ')}
                .
              </p>
            )}
            {scan.status === 'done' && (
              <p className="text-sm text-ink-muted">
                {n(scan.candidatesTested)} rules were tried, so some will look good by chance: only
                Verified patterns passed the holdout test after correcting for that. Universes are
                today&rsquo;s members, so earlier years leave out companies that have since left
                (survivorship bias).
              </p>
            )}
          </section>
        </Card>
        {scan.status === 'done' && (
          <Card>
            <section aria-labelledby="verified-heading" className="space-y-4">
              <h2 id="verified-heading" className="text-lg font-semibold">
                Verified patterns ({verified.length})
              </h2>
              {verified.length ? (
                <PatternTable patterns={verified} label="Verified patterns" />
              ) : (
                <p className="text-sm text-ink-muted">
                  No pattern passed the holdout test. That is a valid result: none of the rules the
                  search found held up on unseen days.
                </p>
              )}
            </section>
          </Card>
        )}
        {candidates.length > 0 && (
          <Card>
            <section aria-labelledby="candidates-heading" className="space-y-4">
              <h2 id="candidates-heading" className="text-lg font-semibold">
                Candidates that did not verify ({candidates.length})
              </h2>
              <PatternTable patterns={candidates} label="Candidate patterns" />
            </section>
          </Card>
        )}
      </div>
    </>
  );
}
