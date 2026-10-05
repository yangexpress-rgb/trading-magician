import { Button, Card } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fakeStripe } from '@/lib/server/billing';
import { portalAction } from '../../actions';

export const metadata: Metadata = { title: 'Test billing portal' };

const ACTIONS = [
  ['cancel_at_period_end', 'Cancel at the end of the period'],
  ['keep', 'Keep the subscription'],
  ['end_period', 'End the billing period now'],
  ['fail_payment', 'Make the next payment fail'],
  ['pay_invoice', 'Pay the overdue invoice'],
  ['cancel_now', 'Cancel now'],
  ['replay', 'Send every event again'],
] as const;

/** Stands in for Stripe's customer portal in tests (ADR 0023). */
export default async function FakePortalPage({
  params,
  searchParams,
}: {
  params: Promise<{ subscriptionId: string }>;
  searchParams: Promise<{ return?: string; done?: string }>;
}) {
  const { subscriptionId } = await params;
  const { return: returnUrl = '/settings/billing', done } = await searchParams;
  const sub = await fakeStripe()?.getSubscription(subscriptionId);
  if (!sub) notFound();
  const backPath = (() => {
    try {
      const u = new URL(returnUrl, 'http://x');
      return `${u.pathname}${u.search}`;
    } catch {
      return '/settings/billing';
    }
  })();
  return (
    <main className="mx-auto max-w-md p-6">
      <Card aria-labelledby="portal-heading" className="space-y-4">
        <h1 id="portal-heading" className="text-lg font-semibold">
          Test billing portal
        </h1>
        <p className="text-sm text-ink-muted">
          This page stands in for Stripe in tests. Subscription status:{' '}
          <strong className="text-ink">{sub.status}</strong>
          {sub.cancelAtPeriodEnd ? ', cancels at the end of the period' : ''}.
        </p>
        {done ? (
          <p role="status" className="text-sm">
            Done: {done.replaceAll('_', ' ')}
          </p>
        ) : null}
        <div className="flex flex-col items-start gap-2">
          {ACTIONS.map(([action, label]) => (
            <form key={action} action={portalAction}>
              <input type="hidden" name="subscriptionId" value={sub.id} />
              <input type="hidden" name="returnUrl" value={returnUrl} />
              <input type="hidden" name="action" value={action} />
              <Button type="submit" variant="secondary">
                {label}
              </Button>
            </form>
          ))}
        </div>
        <Link href={backPath} className="text-sm underline">
          Back to Trading Magician
        </Link>
      </Card>
    </main>
  );
}
