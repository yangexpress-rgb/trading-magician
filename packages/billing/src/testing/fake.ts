import { randomBytes } from 'node:crypto';
import { signWebhook, verifyWebhook } from '../signature';
import { readEvent, readSubscription } from '../stripe';
import type {
  BillingEvent,
  BillingProvider,
  CheckoutRequest,
  ProviderSubscription,
  SubscriptionStatus,
} from '../types';

/**
 * An in-memory stand-in for Stripe Billing (ADR 0023), for tests and local
 * development. It keeps checkout sessions, customers and subscriptions, and
 * sends Stripe-shaped, signed webhook events through `deliver`, so the app's
 * real webhook path is what gets tested. `replay()` sends every event again.
 */

export interface FakeStripeOptions {
  webhookSecret: string;
  /** Where the fake's checkout and portal pages are served, e.g. `${APP_URL}/billing-fake`. */
  pagesUrl: string;
  deliver: (payload: string, signature: string) => Promise<void>;
  now?: () => Date;
}

interface Session extends CheckoutRequest {
  id: string;
  completed: boolean;
}

interface Sub {
  id: string;
  customer: string;
  status: SubscriptionStatus;
  price: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  userId: string;
}

const PERIOD_SEC = 30 * 24 * 3600;
const newId = (prefix: string) => `${prefix}_fake${randomBytes(8).toString('hex')}`;

export class FakeStripe implements BillingProvider {
  readonly name = 'stripe' as const;
  readonly sessions = new Map<string, Session>();
  readonly subscriptions = new Map<string, Sub>();
  /** Every event sent so far, as the JSON payload that was signed. */
  readonly events: string[] = [];
  private readonly now: () => Date;

  constructor(private readonly options: FakeStripeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private seconds() {
    return Math.floor(this.now().getTime() / 1000);
  }

  private stripeSubscription(s: Sub) {
    return {
      id: s.id,
      object: 'subscription',
      customer: s.customer,
      status: s.status,
      cancel_at_period_end: s.cancelAtPeriodEnd,
      metadata: { user_id: s.userId },
      items: {
        data: [{ price: { id: s.price }, current_period_end: s.currentPeriodEnd }],
      },
    };
  }

  private async emit(type: string, object: Record<string, unknown>) {
    const payload = JSON.stringify({
      id: newId('evt'),
      object: 'event',
      type,
      created: this.seconds(),
      data: { object },
    });
    this.events.push(payload);
    await this.options.deliver(
      payload,
      signWebhook(payload, this.options.webhookSecret, this.now()),
    );
  }

  async createCheckoutSession(request: CheckoutRequest) {
    const id = newId('cs');
    this.sessions.set(id, { ...request, id, completed: false });
    return { id, url: `${this.options.pagesUrl}/checkout/${id}` };
  }

  async createPortalSession(request: { customerId: string; returnUrl: string }) {
    const sub = [...this.subscriptions.values()].find((s) => s.customer === request.customerId);
    const q = new URLSearchParams({ return: request.returnUrl });
    return { url: `${this.options.pagesUrl}/portal/${sub?.id ?? 'none'}?${q}` };
  }

  async getSubscription(id: string): Promise<ProviderSubscription | null> {
    const s = this.subscriptions.get(id);
    return s ? readSubscription(this.stripeSubscription(s)) : null;
  }

  parseWebhook(payload: string, signatureHeader: string | null, now = this.now()): BillingEvent {
    verifyWebhook(payload, signatureHeader, this.options.webhookSecret, now);
    return readEvent(JSON.parse(payload));
  }

  session(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** The customer pays on the checkout page. Returns where Stripe would send them next. */
  async completeCheckout(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session || session.completed) throw new Error('No open checkout session');
    session.completed = true;
    const sub: Sub = {
      id: newId('sub'),
      customer: session.customerId ?? newId('cus'),
      status: 'active',
      price: session.priceId,
      currentPeriodEnd: this.seconds() + PERIOD_SEC,
      cancelAtPeriodEnd: false,
      userId: session.userId,
    };
    this.subscriptions.set(sub.id, sub);
    await this.emit('customer.subscription.created', this.stripeSubscription(sub));
    await this.emit('checkout.session.completed', {
      id: session.id,
      object: 'checkout.session',
      mode: 'subscription',
      customer: sub.customer,
      subscription: sub.id,
      client_reference_id: session.userId,
      metadata: { user_id: session.userId },
    });
    return session.successUrl;
  }

  private get(id: string): Sub {
    const s = this.subscriptions.get(id);
    if (!s) throw new Error('No such subscription');
    return s;
  }

  private async updated(s: Sub) {
    await this.emit('customer.subscription.updated', this.stripeSubscription(s));
  }

  /** In the portal: cancel when the paid period ends (true) or undo that (false). */
  async setCancelAtPeriodEnd(id: string, cancel: boolean) {
    const s = this.get(id);
    s.cancelAtPeriodEnd = cancel;
    await this.updated(s);
  }

  async changePrice(id: string, price: string) {
    const s = this.get(id);
    s.price = price;
    await this.updated(s);
  }

  /** A renewal payment fails: the subscription is past due. */
  async failPayment(id: string) {
    const s = this.get(id);
    s.status = 'past_due';
    await this.emit('invoice.payment_failed', {
      id: newId('in'),
      object: 'invoice',
      customer: s.customer,
      parent: { subscription_details: { subscription: s.id } },
    });
    await this.updated(s);
  }

  async payInvoice(id: string) {
    const s = this.get(id);
    s.status = 'active';
    s.currentPeriodEnd = this.seconds() + PERIOD_SEC;
    await this.emit('invoice.paid', {
      id: newId('in'),
      object: 'invoice',
      customer: s.customer,
      parent: { subscription_details: { subscription: s.id } },
    });
    await this.updated(s);
  }

  /** The paid period ends: a subscription set to cancel ends now; others renew. */
  async endPeriod(id: string) {
    const s = this.get(id);
    if (s.cancelAtPeriodEnd) return this.cancelNow(id);
    s.currentPeriodEnd = this.seconds() + PERIOD_SEC;
    await this.updated(s);
  }

  async cancelNow(id: string) {
    const s = this.get(id);
    s.status = 'canceled';
    await this.emit('customer.subscription.deleted', this.stripeSubscription(s));
  }

  /** Sends every event again, in order, with fresh signatures. */
  async replay() {
    for (const payload of [...this.events]) {
      await this.options.deliver(
        payload,
        signWebhook(payload, this.options.webhookSecret, this.now()),
      );
    }
  }
}
