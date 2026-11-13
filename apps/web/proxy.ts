import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp } from './lib/csp';

const PUBLIC_PATHS = [
  '/sign-in',
  '/sign-up',
  '/check-email',
  '/forgot-password',
  '/reset-password',
  '/terms',
  '/privacy',
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Fast redirect for visitors without a session cookie. This is a convenience
  // only; every protected page and action re-checks the session on the server.
  if (!isPublic && !getSessionCookie(request)) {
    const signIn = new URL('/sign-in', request.url);
    // An AI agent's sign-in comes back to its consent screen afterwards (N263).
    if (pathname === '/oauth/authorize') {
      signIn.searchParams.set('next', `${pathname}${request.nextUrl.search}`);
    }
    return NextResponse.redirect(signIn);
  }

  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV === 'development' });
  const requestHeaders = new Headers(request.headers);
  // Next.js reads the nonce from the request's CSP header and applies it to its scripts.
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // The manifest and app icons must load without a session: browsers fetch
      // them without cookies when installing the app (N250).
      // OAuth discovery documents for AI agents are public too (ADR 0092).
      source:
        '/((?!api/|\\.well-known/|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon.svg|apple-icon.png|icons/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
