import { Card, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import { GuideVideo } from '@/components/guide/guide-video';

export const metadata: Metadata = { title: 'Help' };

/** The guide's permanent home (N248); the welcome card on Strategy Lab can be dismissed. */
export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help" description="Getting started with Trading Magician." />
      <Card aria-labelledby="guide-title">
        <h2 id="guide-title" className="mb-4 text-lg font-semibold">
          New-user guide
        </h2>
        <GuideVideo />
      </Card>
    </>
  );
}
