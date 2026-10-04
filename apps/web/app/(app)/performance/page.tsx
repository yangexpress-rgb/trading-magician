import { ChartIcon, EmptyState, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Performance' };

export default function PerformancePage() {
  return (
    <>
      <PageHeader
        title="Performance"
        description="Results by strategy, account, asset and period, from reconciled fills."
      />
      <EmptyState icon={<ChartIcon />} title="Nothing to measure yet">
        Performance is calculated from filled orders. Once a paper strategy has completed a trade,
        its results will show here.
      </EmptyState>
    </>
  );
}
