import {
  companionHello,
  companionInstruments,
  companionMembership,
  rateLimitHit,
  resolveAgentCredential,
  touchAgentConnection,
  withTenant,
  type Database,
  type ResolvedAgentCredential,
  type Transaction,
} from '@tm/db';
import { z } from 'zod';

/**
 * The Local Companion API (storage separation S2, ADR 0116). A companion
 * authenticates with its pairing token (`Authorization: Bearer tma_…`, scope
 * `research_sync`) and acts as the person who paired it. It can say hello,
 * pull read-only reference data, and (later steps) push Frozen Outputs. It
 * can never trade, read credentials or call an AI agent tool; AI agent tokens
 * are refused here.
 */

/** Calls per companion per minute. */
export const COMPANION_CALLS_PER_MINUTE = 120;
/** Instruments per page. */
export const COMPANION_PAGE_SIZE = 1000;

export interface CompanionDeps {
  db: Database;
  now?: () => Date;
}

export interface CompanionContext {
  cred: ResolvedAgentCredential;
  asUser: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const refuse = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const STATE_MESSAGES: Record<Exclude<ResolvedAgentCredential['state'], 'ok'>, string> = {
  revoked:
    'This companion was unpaired. Pair it again in Trading Magician › Settings › Local research storage.',
  expired:
    'This companion pairing has expired. Pair it again in Trading Magician › Settings › Local research storage.',
  closed: 'This Trading Magician account is closed or locked.',
};

/** Authenticates a companion call, then runs `fn` as the person who paired it. */
export async function withCompanion(
  request: Request,
  deps: CompanionDeps,
  fn: (ctx: CompanionContext) => Promise<Response>,
): Promise<Response> {
  const secret = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!secret) return refuse(401, 'unauthorized', 'Send the pairing token as a Bearer token');
  const cred = await resolveAgentCredential(deps.db, secret);
  if (!cred || cred.kind !== 'token' || cred.scope !== 'research_sync') {
    return refuse(401, 'unauthorized', 'The token is not a companion pairing');
  }
  if (cred.state !== 'ok')
    return refuse(401, `connection_${cred.state}`, STATE_MESSAGES[cred.state]);
  const wait = await rateLimitHit(
    deps.db,
    `companion:${cred.connectionId}`,
    COMPANION_CALLS_PER_MINUTE,
    60,
  );
  if (wait > 0) {
    return Response.json(
      { error: { code: 'rate_limited', message: 'Too many calls; try again shortly' } },
      { status: 429, headers: { 'retry-after': String(wait), 'cache-control': 'no-store' } },
    );
  }
  const asUser = <T>(f: (tx: Transaction) => Promise<T>) =>
    withTenant(deps.db, { userId: cred.userId }, f);
  await asUser((tx) => touchAgentConnection(tx, cred.connectionId));
  return fn({ cred, asUser });
}

const HelloBody = z.object({
  version: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
});

/** POST /api/companion/v1/hello: the companion is alive; returns who it acts for. */
export function handleHello(request: Request, deps: CompanionDeps): Promise<Response> {
  return withCompanion(request, deps, async ({ cred, asUser }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return refuse(400, 'bad_request', 'The body must be JSON');
    }
    const parsed = HelloBody.safeParse(body);
    if (!parsed.success) {
      return refuse(400, 'bad_request', 'Send version and platform, each 1 to 40 characters');
    }
    const seen = await asUser((tx) =>
      companionHello(tx, { connectionId: cred.connectionId, userId: cred.userId }, parsed.data),
    );
    return json({
      connectionId: cred.connectionId,
      seenAt: seen.seenAt,
      serverTime: (deps.now ?? (() => new Date()))().toISOString(),
    });
  });
}

/** GET /api/companion/v1/instruments?after=<id>: one page of instruments, in id order. */
export function handleInstruments(request: Request, deps: CompanionDeps): Promise<Response> {
  return withCompanion(request, deps, async ({ asUser }) => {
    const after = new URL(request.url).searchParams.get('after') ?? undefined;
    if (after !== undefined && !z.uuid().safeParse(after).success) {
      return refuse(400, 'bad_request', 'after must be an instrument id');
    }
    const rows = await asUser((tx) =>
      companionInstruments(tx, { after, limit: COMPANION_PAGE_SIZE }),
    );
    const last = rows.at(-1);
    return json({
      instruments: rows,
      next: rows.length === COMPANION_PAGE_SIZE && last ? last.id : null,
    });
  });
}

/** GET /api/companion/v1/membership: point-in-time group membership periods. */
export function handleMembership(request: Request, deps: CompanionDeps): Promise<Response> {
  return withCompanion(request, deps, async ({ asUser }) =>
    json({ periods: await asUser((tx) => companionMembership(tx)) }),
  );
}
