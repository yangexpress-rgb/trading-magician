import { BillingRequestError, BillingUnavailableError } from '@tm/billing';
import type { ApiErrorBody, ApiErrorCode, ApiIssue } from '@tm/contracts';
import {
  AgentConnectionError,
  CredentialError,
  IntegrationError,
  LibraryError,
  OrderError,
  PlanLimitError,
  SealError,
  ShareError,
  StrategyError,
} from '@tm/db';
import type { z } from 'zod';

/**
 * How known errors read to whoever asked: the /api/v1 routes and the MCP
 * endpoint (ADR 0092) both answer with these, so an agent sees the same
 * messages and field issues as the screens do.
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

export type KnownError = ApiErrorBody['error'];

export function toIssues(issues: readonly z.core.$ZodIssue[]): ApiIssue[] {
  return issues.map((i) => ({
    path: i.path.filter((p): p is string | number => typeof p !== 'symbol'),
    message: i.message,
  }));
}

/** The error body for a known error, or null for anything else (a 500). */
export function knownError(error: unknown): KnownError | null {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof BillingUnavailableError) {
    return {
      code: 'unavailable',
      message: 'Billing is not reachable right now. Try again shortly.',
    };
  }
  if (error instanceof BillingRequestError) {
    return {
      code: 'unavailable',
      message: 'Billing could not do that right now. Try again later.',
    };
  }
  if (error instanceof PlanLimitError) {
    return { code: 'plan_limit', message: error.message, details: error.details };
  }
  if (error instanceof OrderError) return { code: error.code, message: error.message };
  if (error instanceof CredentialError) return { code: error.code, message: error.message };
  if (error instanceof AgentConnectionError) return { code: error.code, message: error.message };
  if (error instanceof IntegrationError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof SealError) {
    // A misconfigured key; the message names no secret.
    return { code: 'unavailable', message: 'Secure credential storage is not set up correctly' };
  }
  if (error instanceof ShareError) return { code: error.code, message: error.message };
  if (error instanceof LibraryError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.issues ? { issues: error.issues } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof StrategyError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.code === 'invalid_definition' && Array.isArray(error.details)
        ? { issues: toIssues(error.details as z.core.$ZodIssue[]) }
        : error.details !== undefined
          ? { details: error.details }
          : {}),
    };
  }
  return null;
}
