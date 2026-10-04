import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export const GET = (req: Request) => toNextJsHandler(auth()).GET(req);
export const POST = (req: Request) => toNextJsHandler(auth()).POST(req);
