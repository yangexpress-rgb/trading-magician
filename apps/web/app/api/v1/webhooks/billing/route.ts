import { handleBillingWebhook, WebhookRejected } from '@/lib/server/billing';

export const dynamic = 'force-dynamic';

/**
 * The billing provider's webhook (§4.3, §14; ADR 0023). No session and no
 * same-origin check: the signature is what makes it genuine. Errors are
 * answered so the provider retries (5xx) or gives up (4xx); nothing about the
 * event is logged beyond its outcome.
 */
export async function POST(request: Request): Promise<Response> {
  const payload = await request.text();
  if (payload.length > 512 * 1024) return Response.json({ received: false }, { status: 413 });
  try {
    const outcome = await handleBillingWebhook(payload, request.headers.get('stripe-signature'));
    return Response.json({ received: true, outcome });
  } catch (error) {
    if (error instanceof WebhookRejected) {
      return Response.json({ received: false, error: error.message }, { status: error.status });
    }
    const e = error as { name?: string; message?: string };
    // eslint-disable-next-line no-console -- server log; the web app has no structured logger yet
    console.error('Billing webhook failed', { name: e.name, message: e.message });
    return Response.json({ received: false }, { status: 500 });
  }
}
