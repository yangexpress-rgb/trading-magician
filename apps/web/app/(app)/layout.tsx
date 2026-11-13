import { listAgentConnections, pendingShareCount, withTenant } from '@tm/db';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { isAdmin } from '@/lib/server/admin';
import { serverEnv } from '@/lib/server/env';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  // Shares waiting for an answer (ADR 0056), counted beside Sharing.
  const { pendingShares, connectedAgents } = await withTenant(appDb(), tenant, async (tx) => ({
    pendingShares: await pendingShareCount(tx, tenant.userId),
    // Agents that can read a screen snapshot, for the Ask AI panel (N272).
    connectedAgents: [
      ...new Set(
        (await listAgentConnections(tx))
          .filter((c) => c.status === 'active')
          .map((c) => c.profileId),
      ),
    ],
  }));
  return (
    <AppShell
      email={tenant.email}
      isAdmin={await isAdmin()}
      pendingShares={pendingShares}
      connectedAgents={serverEnv().AGENT_API_ENABLED ? connectedAgents : []}
    >
      {children}
    </AppShell>
  );
}
