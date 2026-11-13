import { listAgentCalls, listAgentConnections, withTenant } from '@tm/db';
import { Alert, Card } from '@tm/ui';
import type { Metadata } from 'next';
import { AGENT_PROFILES, mcpEndpoint, museConnectUrl } from '@/lib/agents/profiles';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { AgentActivity, AgentList } from './agents-panels';

export const metadata: Metadata = { title: 'AI agents' };
export const dynamic = 'force-dynamic';

/**
 * Settings › AI agents (Bring your own AI agent brief §2, N262, N271): each
 * agent with one Connect or Disconnect button, its connection details and an
 * Advanced section, then everything agents did in your account.
 */
export default async function AiAgentsPage() {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const env = serverEnv();
  const [connections, calls] = await withTenant(appDb(), tenant, async (tx) => [
    await listAgentConnections(tx),
    await listAgentCalls(tx, { limit: 200 }),
  ]);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  return (
    <div className="space-y-6">
      <Card aria-labelledby="choose-agent-heading">
        <h2 id="choose-agent-heading" className="text-lg font-semibold">
          AI agents
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Connect the AI agent you already use so it can work in Trading Magician as you: look up
          theories, strategies and back tests, and, if you allow it, create strategies and run back
          tests. Agents can never start strategies, place orders, share, delete, or change billing,
          keys or data feeds.
        </p>
        {!env.AGENT_API_ENABLED && (
          <div className="mt-3">
            <Alert tone="warn">
              Connecting agents is switched off on this server for now. You can look around; Connect
              will work once it is switched on.
            </Alert>
          </div>
        )}
        <div className="mt-4">
          <AgentList
            profiles={AGENT_PROFILES}
            connections={connections}
            endpoint={mcpEndpoint(env.APP_URL)}
            museUrl={museConnectUrl(env.APP_URL)}
            enabled={env.AGENT_API_ENABLED}
            prefs={prefs}
          />
        </div>
      </Card>
      <Card aria-labelledby="activity-heading" id="activity">
        <h2 id="activity-heading" className="text-lg font-semibold">
          Activity
        </h2>
        <p className="mt-1 mb-3 text-sm text-ink-muted">
          Every call an agent made in your account, refused ones included, newest first. Kept 90
          days.
        </p>
        <AgentActivity calls={calls} prefs={prefs} />
      </Card>
    </div>
  );
}
