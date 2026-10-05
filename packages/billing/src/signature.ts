import { createHmac, timingSafeEqual } from 'node:crypto';
import { WebhookSignatureError } from './types';

/**
 * Stripe's webhook signature (ADR 0023): the `Stripe-Signature` header holds
 * `t=<unix seconds>` and one or more `v1=<hex HMAC-SHA256 of "t.payload">`.
 * Events older than the tolerance are refused, so a captured request can't be
 * replayed later; a replay inside it is harmless because events are applied once.
 */

export const SIGNATURE_TOLERANCE_SEC = 300;

const hmac = (secret: string, timestamp: number, payload: string) =>
  createHmac('sha256', secret).update(`${timestamp}.${payload}`, 'utf8').digest('hex');

export function signWebhook(payload: string, secret: string, at = new Date()): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${hmac(secret, t, payload)}`;
}

export function verifyWebhook(
  payload: string,
  header: string | null,
  secret: string,
  now = new Date(),
  toleranceSec = SIGNATURE_TOLERANCE_SEC,
): void {
  if (!header) throw new WebhookSignatureError('The webhook has no signature');
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new WebhookSignatureError('The webhook signature is malformed');
  }
  if (Math.abs(now.getTime() / 1000 - timestamp) > toleranceSec) {
    throw new WebhookSignatureError('The webhook is too old');
  }
  const expected = Buffer.from(hmac(secret, timestamp, payload), 'hex');
  const ok = signatures.some((s) => {
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) throw new WebhookSignatureError();
}
