import 'server-only';
import {
  API_ERROR_STATUS,
  type ApiErrorBody,
  type ApiErrorCode,
  type ApiIssue,
} from '@tm/contracts';
import {
  CredentialError,
  IntegrationError,
  OrderError,
  SealError,
  provisionWorkspace,
  StrategyError,
  withTenant,
  type Transaction,
} from '@tm/db';
import { headers } from 'next/headers';
import type { z } from 'zod';
import { createRateLimiter } from '../rate-limit';
import { auth } from './auth';
import { appDb } from './db';
import { serverEnv } from './env';

/**
 * Plumbing shared by the /api/v1 route handlers:
 * - the tenant comes from the server-side session only (401 without one);
 * - mutating requests must come from the app's own origin (CSRF defence on top
 *   of SameSite=Lax cookies) and are rate limited per user;
 * - request bodies and queries are validated with the @tm/contracts schemas;
 * - known errors map to the shared error body; anything else is a logged 500
 *   with no internals in the response.
 */

export class HttpError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly issues?: ApiIssue[],
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const limiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApiContext {
  userId: string;
  /** Runs `fn` in a transaction scoped to the signed-in tenant. */
  tx: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
}

function errorResponse(
  code: ApiErrorCode,
  message: string,
  extra: Partial<ApiErrorBody['error']> = {},
  init: ResponseInit = {},
) {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return Response.json(body, { ...init, status: API_ERROR_STATUS[code] });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === new URL(serverEnv().APP_URL).origin;
}

export function api<P extends Record<string, string> = Record<string, never>>(
  handler: (request: Request, ctx: ApiContext, params: P) => Promise<Response>,
) {
  return async (request: Request, route?: { params?: Promise<P> }): Promise<Response> => {
    try {
      const mutating = MUTATING.has(request.method);
      if (mutating && !sameOrigin(request)) {
        return errorResponse('forbidden_origin', 'This request must come from the app itself');
      }
      const session = await auth().api.getSession({ headers: await headers() });
      if (!session) return errorResponse('unauthenticated', 'Sign in to continue');
      const userId = session.user.id;
      if (mutating) {
        const retryAfter = limiter.hit(userId);
        if (retryAfter > 0) {
          return errorResponse(
            'rate_limited',
            'Too many changes in a short time. Wait a moment and try again.',
            {},
            { headers: { 'retry-after': String(retryAfter) } },
          );
        }
      }
      await provisionWorkspace(appDb(), { userId, displayName: session.user.name });
      // Routes without dynamic segments receive no params.
      const params = ((await route?.params) ?? {}) as P;
      if ('id' in params && !UUID.test(params.id ?? '')) {
        return errorResponse('not_found', 'Strategy not found');
      }
      if ('runId' in params && !UUID.test(params.runId ?? '')) {
        return errorResponse('not_found', 'Back test not found');
      }
      if ('orderId' in params && !UUID.test(params.orderId ?? '')) {
        return errorResponse('not_found', 'Order not found');
      }
      if ('runtimeId' in params && !UUID.test(params.runtimeId ?? '')) {
        return errorResponse('not_found', 'Strategy run not found');
      }
      if ('incidentId' in params && !UUID.test(params.incidentId ?? '')) {
        return errorResponse('not_found', 'Incident not found');
      }
      if ('credentialId' in params && !UUID.test(params.credentialId ?? '')) {
        return errorResponse('not_found', 'Credential not found');
      }
      if ('feedId' in params && !UUID.test(params.feedId ?? '')) {
        return errorResponse('not_found', 'Data feed not found');
      }
      if ('routeId' in params && !UUID.test(params.routeId ?? '')) {
        return errorResponse('not_found', 'Route not found');
      }
      if ('lookupId' in params && !UUID.test(params.lookupId ?? '')) {
        return errorResponse('not_found', 'Lookup not found');
      }
      return await handler(
        request,
        { userId, tx: (fn) => withTenant(appDb(), { userId }, fn) },
        params,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.code, error.message, {
          ...(error.issues ? { issues: error.issues } : {}),
          ...(error.details !== undefined ? { details: error.details } : {}),
        });
      }
      if (error instanceof OrderError) return errorResponse(error.code, error.message);
      if (error instanceof CredentialError) return errorResponse(error.code, error.message);
      if (error instanceof IntegrationError) {
        return errorResponse(
          error.code,
          error.message,
          error.details !== undefined ? { details: error.details } : {},
        );
      }
      if (error instanceof SealError) {
        // A misconfigured key; the message names no secret.
        return errorResponse('unavailable', 'Secure credential storage is not set up correctly');
      }
      if (error instanceof StrategyError) {
        return errorResponse(error.code, error.message, {
          ...(error.code === 'invalid_definition' && Array.isArray(error.details)
            ? { issues: toIssues(error.details as z.core.$ZodIssue[]) }
            : error.details !== undefined
              ? { details: error.details }
              : {}),
        });
      }
      // Log the failure without request bodies or query parameters, which may hold user data.
      const e = error as { name?: string; message?: string; code?: string };
      // eslint-disable-next-line no-console -- server log; the web app has no structured logger yet
      console.error('Unhandled API error', request.method, new URL(request.url).pathname, {
        name: e.name,
        code: e.code,
        message: e.message,
      });
      return errorResponse('internal', 'Something went wrong. Try again.');
    }
  };
}

function toIssues(issues: readonly z.core.$ZodIssue[]): ApiIssue[] {
  return issues.map((i) => ({
    path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
    message: i.message,
  }));
}

export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError('bad_request', 'The request body must be JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new HttpError('bad_request', 'Some fields need attention', toIssues(result.error.issues));
  }
  return result.data;
}

export function readQuery<S extends z.ZodType>(request: Request, schema: S): z.output<S> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    raw[key] = all.length > 1 ? all : (all[0] as string);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError('bad_request', 'Some filters are not valid', toIssues(result.error.issues));
  }
  return result.data;
}
