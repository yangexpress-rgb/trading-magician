import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { DealsList } from '@/components/research/deals-list';
import { ResearchNav } from '@/components/research/research-nav';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Deals · Quantitative Research' };

/** The merger deals the app's EDGAR tracker found (free data feeds brief v1 §4; ADR 0058). */
export default async function DealsPage() {
  await requireTenant();
  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Announced mergers and tender offers for US stocks, read from SEC EDGAR filings."
      />
      <ResearchNav />
      <DealsList />
    </>
  );
}
