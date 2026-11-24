import {
  RESEARCH_COMPANION_PAUSED,
  researchStorageStatus,
  sharedFeedOwner,
  withTenant,
  type ResearchStorageStatus,
  type TenantContext,
} from '@tm/db';
import { Alert } from '@tm/ui';
import { appDb } from '@/lib/server/db';
import { serverEnv } from '@/lib/server/env';

/** Whether local research storage is connected (ADR 0116); `cloud` while research runs in the cloud. */
export async function researchStorage(tenant: TenantContext): Promise<ResearchStorageStatus> {
  const mode = serverEnv().RESEARCH_MODE;
  if (mode === 'cloud') return { mode };
  return withTenant(appDb(), tenant, async (tx) =>
    researchStorageStatus(tx, { mode, producerUserId: await sharedFeedOwner(tx) }),
  );
}

/**
 * The plain status research pages show while research runs on a Local
 * Companion that isn't connected. What was last delivered still shows below;
 * nothing else on the page, and nothing in trading, waits on it.
 */
export function CompanionPaused({ status }: { status: ResearchStorageStatus }) {
  if (status.mode === 'cloud' || status.connected) return null;
  return (
    <div role="status" className="mb-4">
      <Alert tone="warn">{RESEARCH_COMPANION_PAUSED}</Alert>
    </div>
  );
}
