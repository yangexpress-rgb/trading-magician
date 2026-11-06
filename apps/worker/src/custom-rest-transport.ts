import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { CUSTOM_REST_LIMITS, hostProblem } from '@tm/domain';

/**
 * How the worker reaches a custom REST feed (ADR 0041): HTTPS only, to a
 * public address only. The host name is checked when the feed is saved and
 * again here, after it is resolved, so a public name pointing into a private
 * network (or re-pointed there later) is refused at connect time. No
 * redirects are followed, answers are size-capped, and every call has the
 * feed's own timeout.
 */

export interface TransportRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: string;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** Every failure a fetch can have, worded for the person; never carries the key. */
export class CustomFetchError extends Error {
  constructor(
    public readonly kind:
      | 'blocked'
      | 'timeout'
      | 'unreachable'
      | 'too_large'
      | 'redirect'
      | 'http'
      | 'not_json'
      | 'held_back',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'CustomFetchError';
  }
}

/** Addresses a feed may never connect to: private, loopback, link-local, shared, reserved. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) {
    // An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return BLOCKED.check(mapped[1], 'ipv4');
    return BLOCKED.check(address, 'ipv6');
  }
  return true;
}

/** A DNS lookup that refuses names resolving to any blocked address. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as unknown as LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || list.length === 0) {
      const e = new CustomFetchError(
        'blocked',
        `${hostname} points to a private or local network address, which feeds may not use`,
      );
      return callback(e as unknown as NodeJS.ErrnoException, '', 4);
    }
    if ((options as { all?: boolean }).all) {
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    }
    const first = list[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
};

/** The real transport: Node's HTTPS client with the guarded lookup. */
export const httpsTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return reject(new CustomFetchError('blocked', 'The URL is not valid'));
    }
    const host = hostProblem(url.hostname);
    if (url.protocol !== 'https:' || host || (url.port && url.port !== '443')) {
      return reject(
        new CustomFetchError('blocked', host ?? 'Only https:// on port 443 is allowed'),
      );
    }
    const max = CUSTOM_REST_LIMITS.maxResponseBytes;
    const r = request(
      url,
      {
        method: 'GET',
        headers: { 'user-agent': 'TradingMagician/1.0 (custom feed)', ...req.headers },
        lookup: guardedLookup,
        // A fresh connection each time: no socket reused across feeds or tenants.
        agent: false,
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            res.destroy();
            reject(
              new CustomFetchError(
                'too_large',
                `The answer is larger than ${max / 1024 / 1024} MB`,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') headers[k.toLowerCase()] = v;
          }
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (e) => reject(e));
      },
    );
    const timer = setTimeout(() => {
      r.destroy(new CustomFetchError('timeout', `No answer within ${req.timeoutMs / 1000} s`));
    }, req.timeoutMs);
    r.on('timeout', () =>
      r.destroy(new CustomFetchError('timeout', `No answer within ${req.timeoutMs / 1000} s`)),
    );
    r.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    r.on('close', () => clearTimeout(timer));
    r.end();
  });

/** Takes the key out of any text that may be shown or logged. */
export function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  let out = text.split(secret).join('••••');
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) out = out.split(encoded).join('••••');
  return out;
}

/**
 * Fetches and parses one JSON answer. Failures are CustomFetchErrors with the
 * exact reason, e.g. the status and the start of the body, key removed.
 */
export async function fetchJson(
  transport: Transport,
  req: TransportRequest & { shownUrl: string },
  secret: string | undefined,
): Promise<unknown> {
  const host = new URL(req.url).hostname;
  let res: TransportResponse;
  try {
    res = await transport(req);
  } catch (e) {
    if (e instanceof CustomFetchError)
      throw new CustomFetchError(e.kind, redact(e.message, secret));
    const code = (e as NodeJS.ErrnoException).code;
    const why =
      code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? `${host} could not be found (DNS)`
        : code === 'ECONNREFUSED'
          ? `${host} refused the connection`
          : code === 'ECONNRESET'
            ? `${host} closed the connection`
            : code?.startsWith('ERR_TLS') || code?.includes('CERT')
              ? `${host}’s HTTPS certificate was not accepted`
              : `${host} could not be reached`;
    throw new CustomFetchError('unreachable', why);
  }
  const snippet = () => {
    const text = redact(res.body.replace(/\s+/g, ' ').trim(), secret).slice(0, 160);
    return text ? `: ${text}` : '';
  };
  if (res.status >= 300 && res.status < 400) {
    throw new CustomFetchError(
      'redirect',
      `${host} answered ${res.status} (a redirect); use the final URL, redirects are not followed`,
      res.status,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    const what =
      res.status === 401 || res.status === 403
        ? ' (the key was refused or lacks access)'
        : res.status === 404
          ? ' (not found: check the URL and symbol)'
          : res.status === 429
            ? ' (rate limited by the provider)'
            : '';
    throw new CustomFetchError(
      'http',
      `${host} answered HTTP ${res.status}${what}${snippet()}`,
      res.status,
    );
  }
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new CustomFetchError(
      'not_json',
      `${host} did not answer with JSON${res.headers['content-type'] ? ` (${res.headers['content-type'].split(';')[0]})` : ''}${snippet()}`,
    );
  }
}
