import type { Database, Transaction } from './client';
import { auditEvents } from './schema';

export interface AuditInput {
  userId: string;
  actorType: 'user' | 'system';
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeRef?: string;
  afterRef?: string;
  /** Must not contain secrets or personal data beyond identifiers (§16.2). */
  context?: Record<string, unknown>;
}

export async function recordAudit(tx: Transaction, event: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    userId: event.userId,
    actorType: event.actorType,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    beforeRef: event.beforeRef ?? null,
    afterRef: event.afterRef ?? null,
    context: event.context ?? {},
  });
}

export interface OperatorAuditInput {
  action: string;
  resourceType: string;
  resourceId?: string;
  /** Must not contain secrets, codes or personal data (§16.2). */
  context?: Record<string, unknown>;
}

/**
 * Records an operator action that belongs to no workspace, such as minting an
 * invite code (deviation D6). The row has no user and is always a system
 * event; only the owner connection may write it (migration 0049).
 */
export async function recordOperatorAudit(
  db: Database | Transaction,
  event: OperatorAuditInput,
): Promise<void> {
  await db.insert(auditEvents).values({
    userId: null,
    actorType: 'system',
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    context: event.context ?? {},
  });
}
