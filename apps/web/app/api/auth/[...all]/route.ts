import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/server/auth';
import { withInvite } from '@/lib/server/invite-gate';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => toNextJsHandler(auth()).GET(req);
/** Sign-up goes through the invite gate first (§16.4, ADR 0026). */
export const POST = (req: Request) => withInvite(req, toNextJsHandler(auth()).POST);
