import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('requires the nonce for scripts and blocks framing and plugins in production', () => {
    const csp = buildCsp('abc123', { dev: false });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('allows eval and websockets only in development', () => {
    const csp = buildCsp('n', { dev: true });
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain('ws:');
  });
});
