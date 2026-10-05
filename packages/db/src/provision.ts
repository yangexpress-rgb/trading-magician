import { eq } from 'drizzle-orm';
import { DEMO_STARTING_EQUITY } from '@tm/domain';
import { recordAudit } from './audit';
import type { Database } from './client';
import { DEMO_ACCOUNT_CAPABILITIES, DEMO_ASSET_CLASSES, DEMO_VENUE } from './demo';
import { startingPlanCode } from './entitlements';
import {
  brokerConnections,
  dataFeedConnections,
  dataRoutes,
  entitlements,
  profiles,
  tradingAccounts,
} from './schema';
import { withTenant } from './tenant';

export interface ProvisionInput {
  userId: string;
  displayName: string;
  timezone?: string;
  /** A plan to start on instead of the catalog's default, if it exists (tests, staging). */
  planCode?: string | undefined;
}

/**
 * Creates a new user's workspace: profile, entitlement to a plan, the demo
 * data feed with routes for every Phase 1 asset class, and one demo paper
 * account. Idempotent: does nothing if the profile already exists.
 */
export async function provisionWorkspace(db: Database, input: ProvisionInput): Promise<boolean> {
  return withTenant(db, { userId: input.userId }, async (tx) => {
    const existing = await tx
      .select({ userId: profiles.userId })
      .from(profiles)
      .where(eq(profiles.userId, input.userId));
    if (existing.length > 0) return false;

    const { userId } = input;
    await tx.insert(profiles).values({
      userId,
      displayName: input.displayName,
      ...(input.timezone ? { timezone: input.timezone } : {}),
    });
    await tx
      .insert(entitlements)
      .values({ userId, planCode: await startingPlanCode(tx, input.planCode) });

    const [feed] = await tx
      .insert(dataFeedConnections)
      .values({
        userId,
        name: 'Demo feed',
        provider: 'demo',
        assetClasses: [...DEMO_ASSET_CLASSES],
        health: 'healthy',
      })
      .returning({ id: dataFeedConnections.id });
    if (!feed) throw new Error('Failed to create demo feed');
    await tx.insert(dataRoutes).values(
      DEMO_ASSET_CLASSES.flatMap((assetClass) =>
        (['quotes', 'bars'] as const).map((dataType) => ({
          userId,
          assetClass,
          venue: DEMO_VENUE,
          dataType,
          primaryFeedId: feed.id,
        })),
      ),
    );

    const [broker] = await tx
      .insert(brokerConnections)
      .values({ userId, name: 'Demo paper broker', provider: 'demo', health: 'healthy' })
      .returning({ id: brokerConnections.id });
    if (!broker) throw new Error('Failed to create demo broker');
    const [account] = await tx
      .insert(tradingAccounts)
      .values({
        userId,
        brokerConnectionId: broker.id,
        nickname: 'Demo paper account',
        maskedExternalId: 'DEMO-••••0001',
        currency: 'USD',
        capabilities: DEMO_ACCOUNT_CAPABILITIES,
        isDefault: true,
        startingEquity: DEMO_STARTING_EQUITY.toString(),
      })
      .returning({ id: tradingAccounts.id });

    await recordAudit(tx, {
      userId,
      actorType: 'system',
      action: 'workspace.provisioned',
      resourceType: 'user',
      resourceId: userId,
      context: { feedId: feed.id, brokerConnectionId: broker.id, accountId: account?.id },
    });
    return true;
  });
}
