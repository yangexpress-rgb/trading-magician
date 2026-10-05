'use server';

import { notFound, redirect } from 'next/navigation';
import { fakeStripe } from '@/lib/server/billing';
import { serverEnv } from '@/lib/server/env';

/**
 * The stand-in's checkout and portal buttons (tests only; ADR 0023). Each
 * changes the fake subscription and sends the signed webhook Stripe would.
 */

function fake() {
  const f = fakeStripe();
  if (!f) notFound();
  return f;
}

const field = (form: FormData, name: string) => String(form.get(name) ?? '');

/** Only back into this app. */
function back(url: string): never {
  const base = new URL(serverEnv().APP_URL);
  const target = new URL(url, base);
  redirect(target.origin === base.origin ? `${target.pathname}${target.search}` : '/');
}

export async function payCheckout(form: FormData) {
  back(await fake().completeCheckout(field(form, 'sessionId')));
}

export async function cancelCheckout(form: FormData) {
  const session = fake().session(field(form, 'sessionId'));
  back(session?.cancelUrl ?? '/settings/billing');
}

const PORTAL_ACTIONS = [
  'cancel_at_period_end',
  'keep',
  'end_period',
  'fail_payment',
  'pay_invoice',
  'cancel_now',
  'replay',
] as const;

export async function portalAction(form: FormData) {
  const f = fake();
  const id = field(form, 'subscriptionId');
  const action = field(form, 'action') as (typeof PORTAL_ACTIONS)[number];
  if (!PORTAL_ACTIONS.includes(action)) notFound();
  if (action === 'cancel_at_period_end') await f.setCancelAtPeriodEnd(id, true);
  if (action === 'keep') await f.setCancelAtPeriodEnd(id, false);
  if (action === 'end_period') await f.endPeriod(id);
  if (action === 'fail_payment') await f.failPayment(id);
  if (action === 'pay_invoice') await f.payInvoice(id);
  if (action === 'cancel_now') await f.cancelNow(id);
  if (action === 'replay') await f.replay();
  const q = new URLSearchParams({ return: field(form, 'returnUrl'), done: action });
  redirect(`/billing-fake/portal/${encodeURIComponent(id)}?${q}`);
}
