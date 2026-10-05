import { verifyWebhook } from './signature';
import {
  BillingRequestError,
  BillingUnavailableError,
  SUBSCRIPTION_STATUSES,
  type BillingEvent,
  type BillingProvider,
  type CheckoutRequest,
  type ProviderSubscription,
  type SubscriptionStatus,
  WebhookSignatureError,
} from './types';

/**
 * A small Stripe Billing client over fetch (ADR 0023). Test mode only: a live
 * secret key is refused until real money is approved, like the paper-only
 * guard for brokers (ADR 0002). Errors never carry the key.
 */

export const STRIPE_API_URL = 'https://api.stripe.com';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export class LiveBillingKeyError extends Error {
  constructor() {
    super('Only Stripe test-mode keys are allowed');
    this.name = 'LiveBillingKeyError';
  }
}

/** Throws unless `key` is a Stripe test-mode secret or restricted key. */
export function assertTestModeKey(key: string): void {
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) throw new LiveBillingKeyError();
}

export interface StripeBillingOptions {
  secretKey: string;
  /** Needed only where webhooks are received (the web app). */
  webhookSecret?: string | undefined;
  fetch?: Fetch | undefined;
  apiUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const idOf = (v: unknown): string | null => str(v) ?? str(obj(v).id);

/** Reads a Stripe subscription object, old and new API shapes alike. */
export function readSubscription(raw: unknown): ProviderSubscription {
  const s = obj(raw);
  const item = obj((obj(s.items).data as unknown[] | undefined)?.[0]);
  // current_period_end moved from the subscription to its items in 2025.
  const periodEnd = s.current_period_end ?? item.current_period_end;
  const status = str(s.status);
  return {
    id: str(s.id) ?? '',
    customerId: idOf(s.customer) ?? '',
    status: (SUBSCRIPTION_STATUSES as readonly string[]).includes(status ?? '')
      ? (status as SubscriptionStatus)
      : 'incomplete',
    priceId: idOf(item.price),
    currentPeriodEnd: typeof periodEnd === 'number' ? new Date(periodEnd * 1000) : null,
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    userId: str(obj(s.metadata).user_id),
  };
}

/** Reads the ids the app needs from a Stripe event, whatever its type. */
export function readEvent(raw: unknown): BillingEvent {
  const e = obj(raw);
  const o = obj(obj(e.data).object);
  const type = str(e.type) ?? '';
  const id = str(e.id);
  if (!id || !type) throw new BillingRequestError(400, 'The webhook is not a Stripe event');
  let subscriptionId: string | null = null;
  if (type.startsWith('customer.subscription.')) subscriptionId = str(o.id);
  else if (type.startsWith('checkout.session.')) subscriptionId = idOf(o.subscription);
  else if (type.startsWith('invoice.')) {
    // Newer API versions move the subscription under parent.subscription_details.
    subscriptionId =
      idOf(o.subscription) ?? idOf(obj(obj(o.parent).subscription_details).subscription);
  }
  return {
    id,
    type,
    created: new Date((typeof e.created === 'number' ? e.created : 0) * 1000),
    userId: str(o.client_reference_id) ?? str(obj(o.metadata).user_id),
    customerId: idOf(o.customer),
    subscriptionId,
  };
}

export class StripeBilling implements BillingProvider {
  readonly name = 'stripe' as const;
  private readonly fetch: Fetch;
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: StripeBillingOptions) {
    assertTestModeKey(options.secretKey);
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.apiUrl = options.apiUrl ?? STRIPE_API_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async call(method: 'GET' | 'POST', path: string, form?: Record<string, string>) {
    let res: Response;
    try {
      res = await this.fetch(`${this.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.secretKey}`,
          ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new BillingUnavailableError();
    }
    if (res.status === 429 || res.status >= 500) throw new BillingUnavailableError();
    const body = obj(await res.json().catch(() => ({})));
    if (!res.ok) {
      const message = str(obj(body.error).message) ?? `Stripe answered ${res.status}`;
      throw new BillingRequestError(res.status, message);
    }
    return body;
  }

  async createCheckoutSession(request: CheckoutRequest) {
    const form: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': request.priceId,
      'line_items[0][quantity]': '1',
      success_url: request.successUrl,
      cancel_url: request.cancelUrl,
      client_reference_id: request.userId,
      'metadata[user_id]': request.userId,
      'subscription_data[metadata][user_id]': request.userId,
    };
    if (request.customerId) form.customer = request.customerId;
    else form.customer_email = request.email;
    const body = await this.call('POST', '/v1/checkout/sessions', form);
    const id = str(body.id);
    const url = str(body.url);
    if (!id || !url) throw new BillingRequestError(502, 'Stripe returned no checkout page');
    return { id, url };
  }

  async createPortalSession(request: { customerId: string; returnUrl: string }) {
    const body = await this.call('POST', '/v1/billing_portal/sessions', {
      customer: request.customerId,
      return_url: request.returnUrl,
    });
    const url = str(body.url);
    if (!url) throw new BillingRequestError(502, 'Stripe returned no billing page');
    return { url };
  }

  async getSubscription(id: string): Promise<ProviderSubscription | null> {
    try {
      return readSubscription(
        await this.call('GET', `/v1/subscriptions/${encodeURIComponent(id)}`),
      );
    } catch (error) {
      if (error instanceof BillingRequestError && error.status === 404) return null;
      throw error;
    }
  }

  parseWebhook(payload: string, signatureHeader: string | null, now = new Date()): BillingEvent {
    if (!this.options.webhookSecret) throw new WebhookSignatureError('No webhook secret is set');
    verifyWebhook(payload, signatureHeader, this.options.webhookSecret, now);
    return readEvent(JSON.parse(payload));
  }
}
