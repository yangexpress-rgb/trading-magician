import { EmptyState, LabIcon, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Strategy Lab' };

export default function StrategyLabPage() {
  return (
    <>
      <PageHeader
        title="Strategy Lab"
        description="Define entry and exit rules across any mix of assets, test them, then run them on paper."
      />
      <EmptyState icon={<LabIcon />} title="No strategies yet">
        Your saved strategies will be listed here. The strategy editor is the next part of the
        build.
      </EmptyState>
    </>
  );
}
