import { getAiAssistant, listAgentConnections, pendingShareCount, withTenant } from '@tm/db';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import type { AskAgent } from '@/components/ask-ai/ask-ai-panel';
import { ASK_AI_PROVIDERS } from '@/lib/ask-ai';
import { isAdmin } from '@/lib/server/admin';
import { serverEnv } from '@/lib/server/env';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  // Shares waiting for an answer (ADR 0056), counted beside Sharing.
  const { pendingShares, askAgent } = await withTenant(appDb(), tenant, async (tx) => {
    const assistant = await getAiAssistant(tx, tenant.userId);
    const museConnected =
      serverEnv().AGENT_API_ENABLED &&
      (await listAgentConnections(tx)).some((c) => c.status === 'active' && c.profileId === 'muse');
    // The one agent the Ask AI panel talks to (N274).
    const askAgent: AskAgent = !assistant
      ? { kind: 'none' }
      : assistant.provider === 'muse'
        ? { kind: 'muse', connected: museConnected }
        : {
            kind: 'chat',
            label: ASK_AI_PROVIDERS.find((p) => p.id === assistant.provider)?.label ?? 'AI',
          };
    return { pendingShares: await pendingShareCount(tx, tenant.userId), askAgent };
  });
  return (
    <AppShell
      email={tenant.email}
      isAdmin={await isAdmin()}
      pendingShares={pendingShares}
      askAgent={askAgent}
    >
      {children}
    </AppShell>
  );
}
