import {
  findOAuthClient,
  rateLimitHit,
  redeemOAuthCode,
  refreshOAuthToken,
  registerOAuthClient,
  revokeOAuthToken,
  verifyOAuthClientSecret,
  type AgentScope,
  type Database,
  type OAuthClient,
  type OAuthTokens,
} from '@tm/db';
import { mcpEndpoint, profileForClientName, type AgentProfile } from '@/lib/agents/profiles';

/**
 * The app as its own OAuth 2.1 authorization server for the MCP endpoint
 * (Bring your own AI agent brief §3b, ADR 0092), following the MCP
 * authorization specification: protected-resource metadata (RFC 9728),
 * authorization-server metadata (RFC 8414), dynamic client registration
 * (RFC 7591), the authorization code grant with PKCE S256 only, rotating
 * refresh tokens, and revocation (RFC 7009). The authorize step is a page
 * behind the normal sign-in, with a consent screen (app/oauth/authorize).
 */

export interface OAuthDeps {
  db: Database;
  appUrl: string;
  enabled: boolean;
}

export const SCOPES: readonly AgentScope[] = ['read', 'operate'];

const origin = (appUrl: string) => new URL(appUrl).origin;

/** CORS for browser-based MCP clients: these endpoints take no cookies. */
export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', pragma: 'no-cache', ...CORS, ...extra },
  });
}

const oauthError = (error: string, description: string, status = 400, extra = {}) =>
  json({ error, error_description: description }, status, extra);

export const notEnabled = () =>
  oauthError('temporarily_unavailable', 'Agent connections are turned off on this server.', 503);

export function protectedResourceMetadata(appUrl: string) {
  return {
    resource: mcpEndpoint(appUrl),
    authorization_servers: [origin(appUrl)],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Trading Magician',
    resource_documentation: `${origin(appUrl)}/settings/ai-agents`,
  };
}

export function authorizationServerMetadata(appUrl: string) {
  const o = origin(appUrl);
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    revocation_endpoint: `${o}/api/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: [
      'none',
      'client_secret_post',
      'client_secret_basic',
    ],
  };
}

export const metadataResponse = (body: unknown) =>
  Response.json(body, { headers: { 'cache-control': 'public, max-age=300', ...CORS } });

/** Redirect URIs agents may register: https anywhere, http only to this machine (RFC 8252). */
export function allowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/** POST /api/oauth/register (RFC 7591). */
export async function handleRegister(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!deps.enabled) return notEnabled();
  // Registration is open to anyone, so the whole endpoint shares one budget.
  if ((await rateLimitHit(deps.db, 'oauth-register', 60, 60)) > 0) {
    return oauthError('temporarily_unavailable', 'Too many registrations. Try again shortly.', 429);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
    if (!body || typeof body !== 'object') throw new Error('not an object');
  } catch {
    return oauthError('invalid_client_metadata', 'The body must be a JSON object');
  }
  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > 10 ||
    !uris.every(
      (u): u is string => typeof u === 'string' && u.length <= 2000 && allowedRedirectUri(u),
    )
  ) {
    return oauthError(
      'invalid_redirect_uri',
      'redirect_uris must list 1 to 10 https URLs (or http on localhost)',
    );
  }
  const method = body.token_endpoint_auth_method ?? 'none';
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
    return oauthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method');
  }
  const grants = body.grant_types;
  if (
    grants !== undefined &&
    (!Array.isArray(grants) ||
      !grants.every((g) => g === 'authorization_code' || g === 'refresh_token'))
  ) {
    return oauthError('invalid_client_metadata', 'Only authorization_code and refresh_token');
  }
  const name =
    typeof body.client_name === 'string' && body.client_name.trim()
      ? body.client_name.trim().slice(0, 200)
      : 'MCP agent';
  const { client, clientSecret, createdAt } = await registerOAuthClient(deps.db, {
    clientName: name,
    redirectUris: uris,
    confidential: method !== 'none',
  });
  return json(
    {
      client_id: client.clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
    },
    201,
  );
}

/** Form or JSON body, as an OAuth token request may be sent either way. */
async function readParams(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** The client from Basic auth or the body, checked against its secret when it has one. */
async function authenticateClient(
  request: Request,
  params: Record<string, string>,
  db: Database,
): Promise<OAuthClient | null> {
  let clientId = params.client_id ?? null;
  let secret = params.client_secret ?? null;
  const basic = /^Basic\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (basic) {
    const decoded = Buffer.from(basic, 'base64').toString('utf8');
    const at = decoded.indexOf(':');
    if (at > 0) {
      clientId = decodeURIComponent(decoded.slice(0, at));
      secret = decodeURIComponent(decoded.slice(at + 1));
    }
  }
  if (!clientId || clientId.length > 100) return null;
  return verifyOAuthClientSecret(db, clientId, secret);
}

const tokenResponse = (t: OAuthTokens) =>
  json({
    access_token: t.accessToken,
    token_type: 'Bearer',
    expires_in: t.expiresIn,
    refresh_token: t.refreshToken,
    scope: t.scope,
  });

/** POST /api/oauth/token: authorization_code and refresh_token grants. */
export async function handleToken(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!deps.enabled) return notEnabled();
  const params = await readParams(request);
  const client = await authenticateClient(request, params, deps.db);
  if (!client) {
    return oauthError('invalid_client', 'Unknown client or wrong client secret', 401, {
      'www-authenticate': 'Basic realm="trading-magician"',
    });
  }
  if (params.grant_type === 'authorization_code') {
    const { code, redirect_uri: redirectUri, code_verifier: verifier } = params;
    if (!code || !redirectUri || !verifier) {
      return oauthError('invalid_request', 'code, redirect_uri and code_verifier are required');
    }
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      return oauthError('invalid_request', 'code_verifier is not a valid PKCE verifier');
    }
    const tokens = await redeemOAuthCode(deps.db, {
      code,
      client,
      redirectUri,
      codeVerifier: verifier,
    });
    if (!tokens) {
      return oauthError('invalid_grant', 'The code is not valid, has expired or was already used');
    }
    return tokenResponse(tokens);
  }
  if (params.grant_type === 'refresh_token') {
    if (!params.refresh_token) return oauthError('invalid_request', 'refresh_token is required');
    const tokens = await refreshOAuthToken(deps.db, { refreshToken: params.refresh_token, client });
    if (!tokens) {
      return oauthError(
        'invalid_grant',
        'The refresh token is not valid or the connection was revoked',
      );
    }
    return tokenResponse(tokens);
  }
  return oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
}

/** POST /api/oauth/revoke (RFC 7009): always 200, whether or not the token was known. */
export async function handleRevoke(request: Request, deps: OAuthDeps): Promise<Response> {
  if (!deps.enabled) return notEnabled();
  const params = await readParams(request);
  const client = await authenticateClient(request, params, deps.db);
  if (!client) return oauthError('invalid_client', 'Unknown client or wrong client secret', 401);
  if (params.token) await revokeOAuthToken(deps.db, { token: params.token, client });
  return new Response(null, { status: 200, headers: { 'cache-control': 'no-store', ...CORS } });
}

// ---------------------------------------------------------------------------
// The authorize request, checked before the consent screen shows

export interface AuthorizeRequest {
  client: OAuthClient;
  profile: AgentProfile;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** Whether the agent asked for operate (or named no scope, so may have it). */
  operateRequested: boolean;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /** Shown on the page: no trustworthy redirect URI to send the person back to. */
  | { ok: false; redirect: null; message: string }
  /** Sent back to the agent's redirect URI (RFC 6749 §4.1.2.1). */
  | { ok: false; redirect: string; message: string };

export function errorRedirect(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
  appUrl: string,
): string {
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  u.searchParams.set('error_description', description);
  if (state !== null) u.searchParams.set('state', state);
  u.searchParams.set('iss', origin(appUrl));
  return u.toString();
}

export function successRedirect(
  redirectUri: string,
  code: string,
  state: string | null,
  appUrl: string,
): string {
  const u = new URL(redirectUri);
  u.searchParams.set('code', code);
  if (state !== null) u.searchParams.set('state', state);
  u.searchParams.set('iss', origin(appUrl));
  return u.toString();
}

export async function checkAuthorize(
  db: Database,
  appUrl: string,
  q: Record<string, string | undefined>,
): Promise<AuthorizeCheck> {
  const client = q.client_id ? await findOAuthClient(db, q.client_id.slice(0, 100)) : null;
  if (!client) {
    return {
      ok: false,
      redirect: null,
      message: 'This agent is not registered with Trading Magician.',
    };
  }
  const redirectUri =
    q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      redirect: null,
      message: 'The agent sent a return address it did not register, so the sign-in stopped here.',
    };
  }
  const state = q.state ?? null;
  const fail = (error: string, message: string): AuthorizeCheck => ({
    ok: false,
    redirect: errorRedirect(redirectUri, error, message, state, appUrl),
    message,
  });
  if (q.response_type !== 'code')
    return fail('unsupported_response_type', 'Use response_type=code');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') {
    return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge)) {
    return fail('invalid_request', 'code_challenge is not an S256 challenge');
  }
  // RFC 8707: a token for another resource is not ours to give.
  if (q.resource && q.resource.replace(/\/$/, '') !== mcpEndpoint(appUrl)) {
    return fail('invalid_target', 'This server issues tokens only for its MCP endpoint');
  }
  const scopes = (q.scope ?? '').split(/\s+/).filter(Boolean);
  return {
    ok: true,
    request: {
      client,
      profile: profileForClientName(client.clientName),
      redirectUri,
      codeChallenge: q.code_challenge,
      state,
      operateRequested: scopes.length === 0 || scopes.includes('operate'),
    },
  };
}
