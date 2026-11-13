/**
 * Content Security Policy (Design v1.0 §16.1). Scripts must carry the
 * per-request nonce; 'strict-dynamic' lets those scripts load Next.js chunks.
 * Inline style attributes stay allowed because React and Next.js emit them;
 * no third-party origins are permitted.
 */
export function buildCsp(nonce: string, { dev }: { dev: boolean }): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self'`,
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    // The installed app's tab bar frames this app's own pages (ADR 0089).
    `frame-ancestors 'self'`,
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
