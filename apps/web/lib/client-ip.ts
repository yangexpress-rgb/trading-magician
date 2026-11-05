import { z } from 'zod';

/**
 * How the sign-in rate limits find the client's address behind a proxy
 * (ADR 0004). Better Auth reads the address from request headers; without
 * these settings it trusts only a single-value header, so behind a proxy that
 * appends to `X-Forwarded-For` every visitor would share one bucket.
 *
 * - `AUTH_IP_HEADERS`: comma-separated header names to read, in order
 *   (for example `x-real-ip` when the host's edge sets it).
 * - `AUTH_TRUSTED_PROXIES`: comma-separated proxy IPs or CIDR ranges. The
 *   forwarded chain is then walked right to left, skipping these hops.
 */
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}(\/(\d|[12]\d|3[0-2]))?$/;
const IPV6 = /^[0-9a-f:]+(\/(\d|[1-9]\d|1[01]\d|12[0-8]))?$/i;
const HEADER = /^[a-z0-9-]{1,64}$/;

const list = (check: (v: string) => boolean, message: string) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (raw === undefined || raw.trim() === '') return undefined;
      const items = raw
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      const bad = items.filter((v) => !check(v));
      if (bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: `${message}: ${bad.join(', ')}` });
        return z.NEVER;
      }
      return items;
    });

const isIp = (v: string) => {
  if (IPV4.test(v)) {
    const [address = ''] = v.split('/');
    return address.split('.').every((o) => Number(o) <= 255);
  }
  return v.includes(':') && IPV6.test(v);
};

export const authIpHeaders = list((v) => HEADER.test(v), 'not a header name');
export const authTrustedProxies = list(isIp, 'not an IP address or CIDR range');

/** The `advanced.ipAddress` block for Better Auth, leaving out what is not set. */
export function ipAddressOptions(settings: {
  AUTH_IP_HEADERS?: string[] | undefined;
  AUTH_TRUSTED_PROXIES?: string[] | undefined;
}): { ipAddressHeaders?: string[]; trustedProxies?: string[] } {
  return {
    ...(settings.AUTH_IP_HEADERS ? { ipAddressHeaders: settings.AUTH_IP_HEADERS } : {}),
    ...(settings.AUTH_TRUSTED_PROXIES ? { trustedProxies: settings.AUTH_TRUSTED_PROXIES } : {}),
  };
}
