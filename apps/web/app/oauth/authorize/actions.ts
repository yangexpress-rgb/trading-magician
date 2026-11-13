'use server';

import { createOAuthCode, withTenant } from '@tm/db';
import { checkAuthorize, errorRedirect, successRedirect } from '@/lib/server/agents/oauth';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { requireTenant } from '@/lib/server/session';

/**
 * The consent screen's answer (N263). The authorize request is checked again
 * here, from the same parameters, so nothing the page showed is trusted.
 * Returns where to send the browser: the agent's redirect URI with a code,
 * or with access_denied.
 */
export async function answerConsent(
  params: Record<string, string | undefined>,
  answer: { approve: boolean; scope: 'read' | 'operate' },
): Promise<{ redirect: string } | { error: string }> {
  const tenant = await requireTenant();
  const env = serverEnv();
  if (!env.AGENT_API_ENABLED) return { error: 'Agent connections are turned off on this server.' };
  const check = await checkAuthorize(appDb(), env.APP_URL, params);
  if (!check.ok) return check.redirect ? { redirect: check.redirect } : { error: check.message };
  const r = check.request;
  if (!answer.approve) {
    return {
      redirect: errorRedirect(
        r.redirectUri,
        'access_denied',
        'The person declined',
        r.state,
        env.APP_URL,
      ),
    };
  }
  const scope = answer.scope === 'operate' && r.operateRequested ? 'operate' : 'read';
  const code = await withTenant(appDb(), tenant, (tx) =>
    createOAuthCode(tx, tenant.userId, {
      clientRowId: r.client.id,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      scope,
      profileId: r.profile.id,
    }),
  );
  return { redirect: successRedirect(r.redirectUri, code, r.state, env.APP_URL) };
}
