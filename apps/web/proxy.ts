import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = [
  '/sign-in',
  '/sign-up',
  '/check-email',
  '/forgot-password',
  '/reset-password',
];

/**
 * Fast redirect for visitors without a session cookie. This is a convenience
 * only; every protected page and action re-checks the session on the server.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }
  if (!getSessionCookie(request)) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api/|_next/|favicon.ico).*)'],
};
