import { Button, Card } from '@tm/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fakeStripe } from '@/lib/server/billing';
import { cancelCheckout, payCheckout } from '../../actions';

export const metadata: Metadata = { title: 'Test checkout' };

/** Stands in for Stripe's hosted checkout in tests (ADR 0023). */
export default async function FakeCheckoutPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const session = fakeStripe()?.session(sessionId);
  if (!session || session.completed) notFound();
  return (
    <main className="mx-auto max-w-md p-6">
      <Card aria-labelledby="checkout-heading" className="space-y-4">
        <h1 id="checkout-heading" className="text-lg font-semibold">
          Test checkout
        </h1>
        <p className="text-sm text-ink-muted">
          This page stands in for Stripe in tests. No card is charged. Price{' '}
          <code>{session.priceId}</code> for {session.email}.
        </p>
        <div className="flex gap-2">
          <form action={payCheckout}>
            <input type="hidden" name="sessionId" value={session.id} />
            <Button type="submit" variant="primary">
              Pay
            </Button>
          </form>
          <form action={cancelCheckout}>
            <input type="hidden" name="sessionId" value={session.id} />
            <Button type="submit" variant="secondary">
              Cancel
            </Button>
          </form>
        </div>
      </Card>
    </main>
  );
}
