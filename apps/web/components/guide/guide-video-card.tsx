'use client';

import { Button, Card } from '@tm/ui';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { markGuideVideoDone } from '@/app/(app)/help/actions';
import { GuideVideo } from './guide-video';

/**
 * The welcome card on Strategy Lab, the first page after sign-up (N248). It
 * shows until the person dismisses it or watches the guide to the end; the
 * choice is kept on their profile (server-side), so it holds on every device.
 */
export function GuideVideoCard() {
  const [dismissed, setDismissed] = useState(false);
  const recorded = useRef(false);

  const record = () => {
    if (recorded.current) return;
    recorded.current = true;
    void markGuideVideoDone();
  };

  if (dismissed) return null;
  return (
    <Card className="mb-6" aria-labelledby="guide-card-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="guide-card-title" className="text-lg font-semibold">
            Welcome to Trading Magician
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            A short tour of designing, testing and running a strategy on paper. It stays under{' '}
            <Link href="/help">Help</Link> after you close this card.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDismissed(true);
            record();
          }}
        >
          Dismiss
        </Button>
      </div>
      <GuideVideo onEnded={record} />
    </Card>
  );
}
