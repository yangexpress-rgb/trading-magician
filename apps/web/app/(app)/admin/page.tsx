import { adminListInvites, adminListUsers, inviteState, listHeartbeats } from '@tm/db';
import { Badge, Card } from '@tm/ui';
import Link from 'next/link';
import { asAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';
import { systemHealth } from '@/lib/system-health';

export const dynamic = 'force-dynamic';

/** The launch admits up to 20 testers (§20 #4, ADR 0026). */
const TESTER_CAP = 20;

function Stat({ label, value, href }: { label: string; value: string | number; href?: string }) {
  const body = (
    <>
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl text-content-strong">{value}</p>
    </>
  );
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      {href ? (
        <Link href={href} className="block no-underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  );
}

export default async function AdminOverviewPage() {
  const env = serverEnv();
  const [users, invites] = await asAdmin(async (tx) => [
    await adminListUsers(tx),
    await adminListInvites(tx),
  ]);
  let beats: Awaited<ReturnType<typeof listHeartbeats>> | null;
  try {
    beats = await listHeartbeats(appDb());
  } catch {
    beats = null;
  }
  const health = systemHealth(beats, new Date());
  const live = users.filter((u) => !u.deletedAt);
  const locked = live.filter((u) => u.lockedAt).length;
  const states = invites.map((i) => inviteState(i));
  const open = states.filter((s) => s === 'open').length;
  const stuck = states.filter((s) => s === 'stuck').length;
  const running = live.reduce((n, u) => n + u.runningStrategies, 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={`Testers (cap ${TESTER_CAP})`} value={live.length} href="/admin/users" />
        <Stat label="Locked" value={locked} href="/admin/users" />
        <Stat label="Open invite codes" value={open} href="/admin/invites" />
        <Stat label="Running strategies" value={running} />
      </div>
      {stuck > 0 && (
        <p className="text-sm">
          {stuck} invite {stuck === 1 ? 'code is' : 'codes are'} stuck on a sign-up that never
          finished. <Link href="/admin/invites">Release it</Link> if the person wants to try again.
        </p>
      )}
      <Card aria-labelledby="health-heading">
        <h2 id="health-heading" className="mb-3 text-lg font-semibold">
          System health
        </h2>
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-ink-muted">Overall</dt>
          <dd className="text-content">
            <Badge tone={health.status === 'ok' ? 'ok' : 'danger'}>
              {health.status === 'ok' ? 'Healthy' : 'Degraded'}
            </Badge>
          </dd>
          <dt className="text-ink-muted">Database</dt>
          <dd className="text-content">{health.database === 'ok' ? 'Answering' : 'Unreachable'}</dd>
          <dt className="text-ink-muted">Worker</dt>
          <dd className="text-content">
            {health.worker === 'never_seen'
              ? 'Never seen'
              : `${health.worker === 'ok' ? 'Alive' : 'Stale'}, last seen ${health.workerLastSeenSeconds}s ago`}
          </dd>
          <dt className="text-ink-muted">Environment</dt>
          <dd className="text-content">{env.RAILWAY_ENVIRONMENT_NAME ?? env.NODE_ENV}</dd>
          <dt className="text-ink-muted">Version</dt>
          <dd className="font-mono">{env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local'}</dd>
          <dt className="text-ink-muted">Sign-up</dt>
          <dd className="text-content">
            {env.SIGNUP_MODE === 'invite' ? 'Invite code needed' : 'Open'}
            {env.EMAIL_VERIFICATION === 'off' ? ', no email sent' : ', email verified'}
          </dd>
          <dt className="text-ink-muted">Trading</dt>
          <dd className="text-content">Paper only</dd>
        </dl>
      </Card>
    </div>
  );
}
