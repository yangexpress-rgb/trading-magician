import type { Transaction } from './client';
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
