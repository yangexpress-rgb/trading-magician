import { pendingShareCount, withTenant } from '@tm/db';
import type { ReactNode } from 'react';
import { TradingStrategyShell } from '@/components/trading/trading-strategy-nav';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

/** The Trading Strategy tab (N156, N194); each section's page draws its header and tabs. */
export default async function TradingStrategyLayout({ children }: { children: ReactNode }) {
  const tenant = await requireTenant();
  const pending = await withTenant(appDb(), tenant, (tx) => pendingShareCount(tx, tenant.userId));
  return <TradingStrategyShell pendingShares={pending}>{children}</TradingStrategyShell>;
}
