import { eq } from 'drizzle-orm';
import { DEMO_STARTING_EQUITY } from '@tm/domain';
import { recordAudit } from './audit';
import type { Database } from './client';
import { DEMO_ACCOUNT_CAPABILITIES, DEMO_ASSET_CLASSES, DEMO_VENUE, demoDataEnabled } from './demo';
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
  /** Whether to add the demo feed; defaults to `DEMO_DATA` (ADR 0039). */
  demo?: boolean | undefined;
}

/**
 * Creates a new user's workspace: profile, entitlement to a plan and one
 * simulated paper account on the built-in paper broker. With demo data on
 * (tests only, ADR 0039) it also adds the demo feed with routes for every
 * Phase 1 asset class, and the paper account trades the demo instruments;
 * otherwise the account trades real US listings, priced by the feed the
 * person adds. Idempotent: does nothing if the profile already exists.
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

    const demo = input.demo ?? demoDataEnabled();
    let feedId: string | undefined;
    if (demo) {
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
      feedId = feed.id;
    }

    const [broker] = await tx
      .insert(brokerConnections)
      .values({
        userId,
        name: demo ? 'Demo paper broker' : 'Built-in paper broker',
        provider: 'demo',
        health: 'healthy',
      })
      .returning({ id: brokerConnections.id });
    if (!broker) throw new Error('Failed to create demo broker');
    const [account] = await tx
      .insert(tradingAccounts)
      .values({
        userId,
        brokerConnectionId: broker.id,
        nickname: demo ? 'Demo paper account' : 'Paper account',
        maskedExternalId: demo ? 'DEMO-••••0001' : 'PAPER-••••0001',
        currency: 'USD',
        capabilities: demo
          ? DEMO_ACCOUNT_CAPABILITIES
          : { ...DEMO_ACCOUNT_CAPABILITIES, coverage: 'us' },
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
      context: { feedId, brokerConnectionId: broker.id, accountId: account?.id },
    });
    return true;
  });
}
