import { describe, expect, it } from 'vitest';
import { authIpHeaders, authTrustedProxies, ipAddressOptions } from './client-ip';

describe('client IP settings', () => {
  it('leaves everything unset by default', () => {
    expect(authIpHeaders.parse(undefined)).toBeUndefined();
    expect(authTrustedProxies.parse('  ')).toBeUndefined();
    expect(ipAddressOptions({})).toEqual({});
  });

  it('reads comma-separated headers and proxies', () => {
    expect(authIpHeaders.parse('X-Real-IP, x-forwarded-for')).toEqual([
      'x-real-ip',
      'x-forwarded-for',
    ]);
    expect(authTrustedProxies.parse('10.0.0.0/8,192.0.2.10, fd00::/8')).toEqual([
      '10.0.0.0/8',
      '192.0.2.10',
      'fd00::/8',
    ]);
  });

  it('refuses values that are not headers or addresses', () => {
    expect(() => authIpHeaders.parse('x real ip')).toThrow(/not a header name/);
    expect(() => authTrustedProxies.parse('10.0.0.300')).toThrow(/not an IP address/);
    expect(() => authTrustedProxies.parse('example.com')).toThrow(/not an IP address/);
    expect(() => authTrustedProxies.parse('10.0.0.0/33')).toThrow(/not an IP address/);
  });

  it('builds the Better Auth block from what is set', () => {
    expect(ipAddressOptions({ AUTH_TRUSTED_PROXIES: ['10.0.0.0/8'] })).toEqual({
      trustedProxies: ['10.0.0.0/8'],
    });
    expect(
      ipAddressOptions({ AUTH_IP_HEADERS: ['x-real-ip'], AUTH_TRUSTED_PROXIES: ['10.0.0.1'] }),
    ).toEqual({ ipAddressHeaders: ['x-real-ip'], trustedProxies: ['10.0.0.1'] });
  });
});
