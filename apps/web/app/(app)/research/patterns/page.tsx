import { factorCoverageReport, withTenant } from '@tm/db';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { CoverageReport } from '@/components/patterns/coverage-report';
import { ResearchNav } from '@/components/research/research-nav';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Patterns · Quantitative Research' };
export const dynamic = 'force-dynamic';

/**
 * Research › Patterns (pattern brief §8, ADR 0091). This first build shows the
 * factor store's coverage report (§3): where each factor's history begins,
 * which bounds every scan's range.
 */
export default async function PatternsPage() {
  const tenant = await requireTenant();
  const report = await withTenant(appDb(), tenant, (tx) => factorCoverageReport(tx));
  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Search point-in-time factors for combinations that were followed, unusually often, by a price move."
      />
      <ResearchNav />
      <CoverageReport report={report} />
    </>
  );
}
