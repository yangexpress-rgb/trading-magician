import { factorCoverageReport, listPatternScans, withTenant } from '@tm/db';
import { AVAILABLE_STOCK_GROUPS } from '@tm/domain';
import { Card, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { CoverageReport } from '@/components/patterns/coverage-report';
import { NewScanForm } from '@/components/patterns/new-scan-form';
import { ScanList } from '@/components/patterns/scan-list';
import { ResearchNav } from '@/components/research/research-nav';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';
import { startPatternScan } from './actions';

export const metadata: Metadata = { title: 'Patterns · Quantitative Research' };
export const dynamic = 'force-dynamic';

/**
 * Research › Patterns (pattern brief §6, §8, ADR 0091): start a scan, the
 * scans so far, and the factor store's coverage report (§3), which bounds
 * every scan's range.
 */
export default async function PatternsPage() {
  const tenant = await requireTenant();
  const [report, scans] = await withTenant(appDb(), tenant, (tx) =>
    Promise.all([factorCoverageReport(tx), listPatternScans(tx)]),
  );
  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Search point-in-time factors for combinations that were followed, unusually often, by a price move."
      />
      <ResearchNav />
      <div className="space-y-6">
        <Card>
          <section aria-labelledby="new-scan-heading" className="space-y-4">
            <header className="space-y-1">
              <h2 id="new-scan-heading" className="text-lg font-semibold">
                New scan
              </h2>
              <p className="text-sm text-ink-muted">
                The search sees the first part of the range only; every pattern it finds is then
                tested once on the rest (the holdout). A scan runs with the miner&rsquo;s next batch
                run, and a scan that verifies nothing is a valid result.
              </p>
            </header>
            <NewScanForm
              action={startPatternScan}
              groups={AVAILABLE_STOCK_GROUPS.map((g) => ({ id: g.id, label: g.label }))}
              shortCategories={['options', 'session']}
            />
          </section>
        </Card>
        <Card>
          <section aria-labelledby="scans-heading" className="space-y-4">
            <h2 id="scans-heading" className="text-lg font-semibold">
              Scans
            </h2>
            <ScanList scans={scans} />
          </section>
        </Card>
        <CoverageReport report={report} />
      </div>
    </>
  );
}
