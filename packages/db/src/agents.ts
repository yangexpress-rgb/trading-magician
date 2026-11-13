import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import {
  agentCallLog,
  agentConnections,
  agentCredentials,
  agentOAuthClients,
  agentOAuthCodes,
} from './schema';

/**
 * Agent connections (Bring your own AI agent brief, ADR 0092): the plumbing
 * an outside AI agent uses to act in the app as one person. Secrets are made
 * here, shown once, and stored only as SHA-256 hashes; the database finds a
 * secret's owner through SECURITY DEFINER functions (migration 0092).
 */

export type AgentScope = 'read' | 'operate';
export type AgentAuthMethod = 'token' | 'oauth';
export type AgentCredentialKind = 'token' | 'access' | 'refresh';

/** Agent tokens (brief §3c): `tma_` and 43 characters of base64url, 256 random bits. */
export const AGENT_TOKEN_PREFIX = 'tma_';
/** OAuth access and refresh tokens and codes carry their own prefixes, to tell them apart in logs. */
export const OAUTH_ACCESS_PREFIX = 'tmo_at_';
export const OAUTH_REFRESH_PREFIX = 'tmo_rt_';
export const OAUTH_CODE_PREFIX = 'tmo_code_';

/** Token expiry choices at minting (brief §3c). */
export const AGENT_TOKEN_EXPIRIES = ['none', '90d', '1y'] as const;
export type AgentTokenExpiry = (typeof AGENT_TOKEN_EXPIRIES)[number];

export class AgentConnectionError extends Error {
  constructor(
    public readonly code: 'not_found' | 'bad_request',
    message: string,
  ) {
    super(message);
  }
}

export function hashAgentSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** A new random secret with `prefix`. */
export function newAgentSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** What Settings shows to tell tokens apart: the prefix and last four characters. */
export function tokenHint(token: string): string {
  return `${AGENT_TOKEN_PREFIX}…${token.slice(-4)}`;
}

function expiryDate(expiry: AgentTokenExpiry, now: Date): Date | null {
  if (expiry === 'none') return null;
  const days = expiry === '90d' ? 90 : 365;
  return new Date(now.getTime() + days * 86_400_000);
}

export interface AgentConnectionSummary {
  id: string;
  profileId: string;
  name: string;
  authMethod: AgentAuthMethod;
  scope: AgentScope;
  tokenHint: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: 'active' | 'revoked' | 'expired';
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toSummary(row: typeof agentConnections.$inferSelect, now = new Date()) {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    authMethod: row.authMethod,
    scope: row.scope,
    tokenHint: row.tokenHint,
    createdAt: row.createdAt.toISOString(),
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
    status: row.revokedAt
      ? 'revoked'
      : row.expiresAt && row.expiresAt <= now
        ? 'expired'
        : 'active',
  } satisfies AgentConnectionSummary;
}

/**
 * Mints an agent token (brief §2b, §3c): one connection of auth type `token`
 * and its one credential. The token is returned here and nowhere else.
 */
export async function createTokenConnection(
  tx: Transaction,
  userId: string,
  input: { profileId: string; name: string; scope: AgentScope; expiry: AgentTokenExpiry },
  now = new Date(),
): Promise<{ connection: AgentConnectionSummary; token: string }> {
  const token = newAgentSecret(AGENT_TOKEN_PREFIX);
  const expiresAt = expiryDate(input.expiry, now);
  const [row] = await tx
    .insert(agentConnections)
    .values({
      userId,
      profileId: input.profileId,
      name: input.name,
      authMethod: 'token',
      scope: input.scope,
      tokenHint: tokenHint(token),
      expiresAt,
    })
    .returning();
  if (!row) throw new Error('agent connection insert failed');
  await tx.insert(agentCredentials).values({
    hash: hashAgentSecret(token),
    connectionId: row.id,
    userId,
    kind: 'token',
    expiresAt,
  });
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'agent_connection.created',
    resourceType: 'agent_connection',
    resourceId: row.id,
    context: { authMethod: 'token', profileId: input.profileId, scope: input.scope },
  });
  return { connection: toSummary(row, now), token };
}

/** The person's connections, newest first. */
export async function listAgentConnections(tx: Transaction): Promise<AgentConnectionSummary[]> {
  const rows = await tx
    .select()
    .from(agentConnections)
    .orderBy(desc(agentConnections.createdAt), desc(agentConnections.id));
  return rows.map((r) => toSummary(r));
}

/** Revokes a connection with immediate effect: its credentials resolve as revoked. */
export async function revokeAgentConnection(
  tx: Transaction,
  userId: string,
  id: string,
): Promise<AgentConnectionSummary> {
  const [row] = await tx
    .update(agentConnections)
    .set({ revokedAt: sql`coalesce(${agentConnections.revokedAt}, now())` })
    .where(eq(agentConnections.id, id))
    .returning();
  if (!row) throw new AgentConnectionError('not_found', 'Connection not found');
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'agent_connection.revoked',
    resourceType: 'agent_connection',
    resourceId: row.id,
    context: { by: 'settings' },
  });
  return toSummary(row);
}

export interface ResolvedAgentCredential {
  connectionId: string;
  userId: string;
  scope: AgentScope;
  profileId: string;
  kind: AgentCredentialKind;
  state: 'ok' | 'revoked' | 'expired' | 'closed';
}

/** Whose secret this is, or null for one that matches nothing. Takes the secret, sends only its hash. */
export async function resolveAgentCredential(
  db: Database,
  secret: string,
): Promise<ResolvedAgentCredential | null> {
  const rows = await db.execute<{
    connection_id: string;
    user_id: string;
    scope: AgentScope;
    profile_id: string;
    kind: AgentCredentialKind;
    state: ResolvedAgentCredential['state'];
  }>(sql`select * from agent_resolve_credential(${hashAgentSecret(secret)})`);
  const r = rows[0];
  if (!r) return null;
  return {
    connectionId: r.connection_id,
    userId: r.user_id,
    scope: r.scope,
    profileId: r.profile_id,
    kind: r.kind,
    state: r.state,
  };
}

/** Marks the connection used; at most one write a minute per connection. */
export async function touchAgentConnection(tx: Transaction, connectionId: string): Promise<void> {
  await tx
    .update(agentConnections)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(agentConnections.id, connectionId),
        or(
          isNull(agentConnections.lastUsedAt),
          lt(agentConnections.lastUsedAt, sql`now() - interval '1 minute'`),
        ),
      ),
    );
}

// ---------------------------------------------------------------------------
// Activity (brief §5)

export type AgentCallOutcome = 'ok' | 'error' | 'refused';

export interface AgentCallInput {
  userId: string;
  connectionId: string | null;
  tool: string;
  args: Record<string, unknown>;
  outcome: AgentCallOutcome;
  errorClass?: string | null | undefined;
  durationMs: number;
}

export async function recordAgentCall(tx: Transaction, call: AgentCallInput): Promise<void> {
  await tx.insert(agentCallLog).values({
    userId: call.userId,
    connectionId: call.connectionId,
    tool: call.tool.slice(0, 80) || 'unknown',
    args: call.args,
    outcome: call.outcome,
    errorClass: call.errorClass ?? null,
    durationMs: Math.max(0, Math.round(call.durationMs)),
  });
}

export interface AgentCallSummary {
  id: string;
  at: string;
  connectionId: string | null;
  connectionName: string | null;
  profileId: string | null;
  tool: string;
  args: Record<string, unknown>;
  outcome: AgentCallOutcome;
  errorClass: string | null;
  durationMs: number;
}

/** The person's agent activity, newest first. */
export async function listAgentCalls(
  tx: Transaction,
  options: { limit?: number; connectionId?: string } = {},
): Promise<AgentCallSummary[]> {
  const rows = await tx
    .select({
      log: agentCallLog,
      name: agentConnections.name,
      profileId: agentConnections.profileId,
    })
    .from(agentCallLog)
    .leftJoin(agentConnections, eq(agentConnections.id, agentCallLog.connectionId))
    .where(options.connectionId ? eq(agentCallLog.connectionId, options.connectionId) : undefined)
    .orderBy(desc(agentCallLog.createdAt), desc(agentCallLog.id))
    .limit(Math.min(Math.max(options.limit ?? 200, 1), 1000));
  return rows.map(({ log, name, profileId }) => ({
    id: log.id,
    at: log.createdAt.toISOString(),
    connectionId: log.connectionId,
    connectionName: name,
    profileId,
    tool: log.tool,
    args: (log.args as Record<string, unknown> | null) ?? {},
    outcome: log.outcome as AgentCallOutcome,
    errorClass: log.errorClass,
    durationMs: log.durationMs,
  }));
}

/** Drops call log rows past retention and spent codes. Worker only. */
export async function pruneAgentLog(db: Database, days = 90): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select agent_log_prune(${days}::integer) as n`);
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// OAuth 2.1 (brief §3b)

export interface OAuthClient {
  id: string;
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** Whether the client must authenticate at the token endpoint with its secret. */
  confidential: boolean;
}

function toClient(row: typeof agentOAuthClients.$inferSelect): OAuthClient {
  return {
    id: row.id,
    clientId: row.clientId,
    clientName: row.clientName,
    redirectUris: row.redirectUris,
    confidential: row.secretHash !== null,
  };
}

/** Dynamic client registration (RFC 7591). A secret is issued only when the client asks for one. */
export async function registerOAuthClient(
  db: Database,
  input: { clientName: string; redirectUris: string[]; confidential: boolean },
): Promise<{ client: OAuthClient; clientSecret: string | null; createdAt: Date }> {
  const clientId = `tmc_${randomBytes(18).toString('base64url')}`;
  const clientSecret = input.confidential ? newAgentSecret('tmcs_') : null;
  const [row] = await db
    .insert(agentOAuthClients)
    .values({
      clientId,
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      secretHash: clientSecret ? hashAgentSecret(clientSecret) : null,
    })
    .returning();
  if (!row) throw new Error('oauth client insert failed');
  return { client: toClient(row), clientSecret, createdAt: row.createdAt };
}

export async function findOAuthClient(
  db: Database | Transaction,
  clientId: string,
): Promise<OAuthClient | null> {
  const [row] = await db
    .select()
    .from(agentOAuthClients)
    .where(eq(agentOAuthClients.clientId, clientId));
  return row ? toClient(row) : null;
}

/** Checks a confidential client's secret; public clients have none to check. */
export async function verifyOAuthClientSecret(
  db: Database,
  clientId: string,
  secret: string | null,
): Promise<OAuthClient | null> {
  const [row] = await db
    .select()
    .from(agentOAuthClients)
    .where(eq(agentOAuthClients.clientId, clientId));
  if (!row) return null;
  if (row.secretHash === null) return toClient(row);
  if (!secret || hashAgentSecret(secret) !== row.secretHash) return null;
  return toClient(row);
}

/** Ten minutes, as RFC 6749 §4.1.2 recommends at most. */
export const OAUTH_CODE_SECONDS = 600;
/** Short-lived access tokens (brief §3b): one hour. */
export const OAUTH_ACCESS_SECONDS = 3600;
/** Refresh tokens rotate on each use and lapse after 30 days unused. */
export const OAUTH_REFRESH_SECONDS = 30 * 86_400;

/** Issues an authorization code after the person approves on the consent screen. */
export async function createOAuthCode(
  tx: Transaction,
  userId: string,
  input: {
    clientRowId: string;
    redirectUri: string;
    codeChallenge: string;
    scope: AgentScope;
    profileId: string;
  },
  now = new Date(),
): Promise<string> {
  const code = newAgentSecret(OAUTH_CODE_PREFIX);
  await tx.insert(agentOAuthCodes).values({
    hash: hashAgentSecret(code),
    userId,
    clientId: input.clientRowId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scope: input.scope,
    profileId: input.profileId,
    expiresAt: new Date(now.getTime() + OAUTH_CODE_SECONDS * 1000),
  });
  return code;
}

/** PKCE S256 (RFC 7636 §4.6): base64url of the SHA-256 of the verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: AgentScope;
  connectionId: string;
}

function newTokenPair(now: Date) {
  const accessToken = newAgentSecret(OAUTH_ACCESS_PREFIX);
  const refreshToken = newAgentSecret(OAUTH_REFRESH_PREFIX);
  return {
    accessToken,
    refreshToken,
    accessExpires: new Date(now.getTime() + OAUTH_ACCESS_SECONDS * 1000),
    refreshExpires: new Date(now.getTime() + OAUTH_REFRESH_SECONDS * 1000),
  };
}

/** The authorization_code grant. Null when the code, client, redirect or verifier don't match. */
export async function redeemOAuthCode(
  db: Database,
  input: { code: string; client: OAuthClient; redirectUri: string; codeVerifier: string },
  now = new Date(),
): Promise<OAuthTokens | null> {
  const pair = newTokenPair(now);
  const rows = await db.execute<{ connection_id: string; scope: AgentScope }>(
    sql`select * from agent_oauth_redeem_code(
      ${hashAgentSecret(input.code)}, ${input.client.id}::uuid, ${input.redirectUri},
      ${pkceChallenge(input.codeVerifier)},
      ${hashAgentSecret(pair.accessToken)}, ${pair.accessExpires.toISOString()}::timestamptz,
      ${hashAgentSecret(pair.refreshToken)}, ${pair.refreshExpires.toISOString()}::timestamptz)`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: OAUTH_ACCESS_SECONDS,
    scope: r.scope,
    connectionId: r.connection_id,
  };
}

/** The refresh_token grant, rotating the refresh token. Null when refused. */
export async function refreshOAuthToken(
  db: Database,
  input: { refreshToken: string; client: OAuthClient },
  now = new Date(),
): Promise<OAuthTokens | null> {
  const pair = newTokenPair(now);
  const rows = await db.execute<{ connection_id: string; scope: AgentScope }>(
    sql`select * from agent_oauth_refresh(
      ${hashAgentSecret(input.refreshToken)}, ${input.client.id}::uuid,
      ${hashAgentSecret(pair.accessToken)}, ${pair.accessExpires.toISOString()}::timestamptz,
      ${hashAgentSecret(pair.refreshToken)}, ${pair.refreshExpires.toISOString()}::timestamptz)`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: OAUTH_ACCESS_SECONDS,
    scope: r.scope,
    connectionId: r.connection_id,
  };
}

/** Token revocation (RFC 7009): revokes the token's connection. */
export async function revokeOAuthToken(
  db: Database,
  input: { token: string; client: OAuthClient },
): Promise<boolean> {
  const rows = await db.execute<{ revoked: boolean }>(
    sql`select agent_oauth_revoke(${hashAgentSecret(input.token)}, ${input.client.id}::uuid) as revoked`,
  );
  return rows[0]?.revoked === true;
}
