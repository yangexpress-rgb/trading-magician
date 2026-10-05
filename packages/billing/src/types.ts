/**
 * The billing provider's side of a subscription (Design v1.0 §4.3; ADR 0023).
 * Only what the app needs: ids, status, price and period. Card details stay
 * with the provider's hosted pages and never reach the app.
 */

export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  /** The price of the subscription's first item; plans map to prices. */
  priceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** Set by the app at checkout. */
  userId: string | null;
}

export interface BillingEvent {
  id: string;
  type: string;
  created: Date;
  /** The user the app named at checkout, when the event carries it. */
  userId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
}

export interface CheckoutRequest {
  userId: string;
  email: string;
  priceId: string;
  /** Reuses the user's customer record when they had a subscription before. */
  customerId?: string | null | undefined;
  successUrl: string;
  cancelUrl: string;
}

export interface BillingProvider {
  readonly name: 'stripe';
  createCheckoutSession(request: CheckoutRequest): Promise<{ id: string; url: string }>;
  createPortalSession(request: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  getSubscription(id: string): Promise<ProviderSubscription | null>;
  /** Checks the signature and reads the event; throws WebhookSignatureError if it is not genuine. */
  parseWebhook(payload: string, signatureHeader: string | null, now?: Date): BillingEvent;
}

/** The provider could not be reached or is throttling; try again later. */
export class BillingUnavailableError extends Error {
  constructor(message = 'Billing is not reachable right now') {
    super(message);
    this.name = 'BillingUnavailableError';
  }
}

/** The provider refused the request; the message is safe to log, never shown with secrets. */
export class BillingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BillingRequestError';
  }
}

export class WebhookSignatureError extends Error {
  constructor(message = 'The webhook signature is not valid') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}
