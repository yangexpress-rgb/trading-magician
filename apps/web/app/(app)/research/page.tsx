import { EmptyState, PageHeader, ResearchIcon } from '@tm/ui';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Quantitative Research' };

/** Reserved route for the deferred research module (Design v1.0 §11). */
export default function ResearchPage() {
  return (
    <>
      <PageHeader
        title="Quantitative Research"
        description="Screen, rank and compare assets across markets."
      />
      <EmptyState icon={<ResearchIcon />} title="Coming in a later release">
        Research tools will let you build screens and formulas, then send selected assets straight
        into the Strategy Lab. For now, start by building a strategy.
      </EmptyState>
    </>
  );
}
