import { ModeBadge } from '@tm/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SCOPE_TEXT } from '@/lib/agents/profiles';
import { auth } from '@/lib/server/auth';
import { checkAuthorize } from '@/lib/server/agents/oauth';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { Consent, ConsentFailed } from './consent';

export const metadata: Metadata = { title: 'Connect an AI agent' };
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The OAuth authorize step (Bring your own AI agent brief §3b, N263): behind
 * the normal sign-in, a consent screen naming the agent and what it may do.
 */
export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Search> }) {
  const raw = await searchParams;
  const q = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, first(v)]));
  const env = serverEnv();
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) {
    const back = `/oauth/authorize?${new URLSearchParams(q as Record<string, string>).toString()}`;
    redirect(`/sign-in?next=${encodeURIComponent(back)}`);
  }
  const check = env.AGENT_API_ENABLED
    ? await checkAuthorize(appDb(), env.APP_URL, q)
    : ({
        ok: false,
        redirect: null,
        message: 'Agent connections are turned off on this server.',
      } as const);
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-16">
      <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <span className="font-semibold">Trading Magician</span>
          <ModeBadge mode="paper" />
        </div>
        {check.ok ? (
          <Consent
            params={q}
            agent={
              check.request.profile.id === 'other-mcp'
                ? check.request.client.clientName
                : check.request.profile.displayName
            }
            clientName={check.request.client.clientName}
            email={session.user.email}
            operateRequested={check.request.operateRequested}
            scopes={SCOPE_TEXT}
          />
        ) : check.redirect ? (
          <ConsentFailed message={check.message} redirect={check.redirect} />
        ) : (
          <div className="space-y-2">
            <h1 className="text-xl font-semibold">This sign-in can’t continue</h1>
            <p className="text-sm">{check.message}</p>
            <p className="text-sm text-ink-muted">Go back to your agent and connect again.</p>
          </div>
        )}
      </div>
    </main>
  );
}
