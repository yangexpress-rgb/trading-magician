import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/server/auth';
import { pickResearchTab, RESEARCH_TAB_COOKIE } from '@/lib/research-tab';

export const dynamic = 'force-dynamic';

/**
 * Where the sidebar's Quantitative Research link lands (N295): the Research
 * tab last viewed, if it was within 30 minutes and in this sign-in; otherwise
 * the Watch list.
 */
export default async function OpenResearch() {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect('/sign-in');
  const signedInAt = new Date(session.session.createdAt).getTime();
  const raw = (await cookies()).get(RESEARCH_TAB_COOKIE)?.value;
  redirect(pickResearchTab(raw, Date.now(), Number.isFinite(signedInAt) ? signedInAt : 0));
}
