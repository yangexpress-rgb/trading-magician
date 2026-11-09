import {
  eq,
  getStrategy,
  listTenantInstruments,
  optionUnderlyingOptions,
  preferredLegAccountId,
  schema,
  StrategyError,
  strategyIdByLabNumber,
  withTenant,
} from '@tm/db';
import { formatDateTime, isLabNumber, STATUS_LABELS } from '@tm/domain';
import { Badge, buttonClasses, Card, ModeBadge, PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ShareButton } from '@/components/sharing/share-button';
import { SharedBy } from '@/components/sharing/shared-by';
import { RowVersionProvider } from '@/components/strategy/row-version';
import { StrategyNameHeading } from '@/components/strategy/strategy-name';
import { StrategyTheoryLine } from '@/components/strategy/strategy-theory';
import { StrategyStatusBadge } from '@/components/strategy-status-badge';
import { isAdmin } from '@/lib/server/admin';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { StrategyEditor } from './strategy-editor';

export const metadata: Metadata = { title: 'Strategy' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function StrategyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await requireTenant();
  // A Lab number (ADR 0065) opens the strategy's canonical URL.
  if (!UUID.test(id)) {
    const number = decodeURIComponent(id);
    if (!isLabNumber(number)) notFound();
    const found = await withTenant(appDb(), tenant, (tx) => strategyIdByLabNumber(tx, number));
    if (!found) notFound();
    redirect(`/strategy-lab/${found}`);
  }
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const loaded = await withTenant(appDb(), tenant, async (tx) => ({
    strategy: await getStrategy(tx, id),
    instruments: await listTenantInstruments(tx),
    optionUnderlyings: await optionUnderlyingOptions(tx),
    accounts: await tx
      .select({
        id: schema.tradingAccounts.id,
        nickname: schema.tradingAccounts.nickname,
        mode: schema.tradingAccounts.mode,
      })
      .from(schema.tradingAccounts)
      .where(eq(schema.tradingAccounts.isActive, true))
      .orderBy(schema.tradingAccounts.nickname),
    preferredAccountId: await preferredLegAccountId(tx),
  })).catch((e: unknown) => {
    if (e instanceof StrategyError && e.code === 'not_found') notFound();
    throw e;
  });
  // Recorded options underlyings (options brief v2 §6) are offered only by the options picker.
  const { strategy, instruments, optionUnderlyings } = loaded;
  // New legs start on the Alpaca paper account when there is one (pickLegAccount).
  const accounts = loaded.accounts.map((a) => ({
    ...a,
    isDefault: a.id === loaded.preferredAccountId,
  }));

  // Moved from the side column into the Execution section (N176).
  const versionsCard = (
    <Card aria-labelledby="versions-heading">
      <h2 id="versions-heading" className="text-lg font-semibold">
        Versions and status history
      </h2>
      {strategy.versions.length === 0 ? (
        <p className="mt-1 text-sm text-ink-muted">
          Draft only. A version is saved when the strategy starts.
        </p>
      ) : (
        <ul className="mt-2 space-y-1 text-sm">
          {strategy.versions.map((v) => (
            <li key={v.id}>
              <Link href={`/strategy-lab/${strategy.id}/versions/${v.versionNo}`}>
                Version {v.versionNo}
              </Link>
              {v.id === strategy.currentVersion?.id && ' (current)'} ·{' '}
              {formatDateTime(v.createdAt, prefs)}
            </li>
          ))}
        </ul>
      )}
      {strategy.hasUnpublishedChanges && strategy.currentVersion && (
        <p className="mt-2 text-sm text-ink-muted">
          The draft has changes since the current version.
        </p>
      )}
      {strategy.statusHistory.length > 0 && (
        <>
          <h3 className="mt-4 text-sm font-semibold">Status history</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {strategy.statusHistory.map((h) => (
              <li key={`${h.changedAt.toISOString()}-${h.toStatus}`}>
                {STATUS_LABELS[h.fromStatus]} → {STATUS_LABELS[h.toStatus]}
                {h.versionNo !== null && h.toStatus === 'actively_executing'
                  ? ` (version ${h.versionNo})`
                  : ''}{' '}
                · {formatDateTime(h.changedAt, prefs)}
                {h.reason && <span className="block text-ink-muted">{h.reason}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );

  return (
    <RowVersionProvider initial={strategy.rowVersion}>
      <p className="mb-2 text-sm">
        <Link href="/strategy-lab">← All strategies</Link>
      </p>
      <PageHeader
        // Double-click the name to rename it (N190).
        title={
          <StrategyNameHeading
            strategyId={strategy.id}
            name={strategy.name}
            initialRowVersion={strategy.rowVersion}
          />
        }
        // The theory it refers to, under its name; double-click to change it (N191).
        subtitle={
          <StrategyTheoryLine
            strategyId={strategy.id}
            library={strategy.library}
            initialRowVersion={strategy.rowVersion}
            editable={strategy.status !== 'actively_executing'}
          />
        }
        description={strategy.description || undefined}
        actions={
          <>
            {/* Its own Lab number (ADR 0065), read-only. Its theory is under the name (N191). */}
            {strategy.labNumber && (
              <span className="font-mono text-sm font-semibold" title="Strategy number">
                {strategy.labNumber}
              </span>
            )}
            {strategy.currentVersion && <Badge>Version {strategy.currentVersion.versionNo}</Badge>}
            <StrategyStatusBadge status={strategy.status} />
            <ModeBadge mode="paper" />
            <Link
              href={`/strategy-lab?copy=${strategy.id}`}
              className={buttonClasses('secondary', 'sm')}
            >
              Make a copy
            </Link>
            {strategy.library && (
              <ShareButton
                source={{ kind: 'lab', strategyId: strategy.id }}
                label={`${strategy.library.registrationNumber} ${strategy.name}`}
                isAdmin={await isAdmin()}
                size="sm"
              />
            )}
          </>
        }
      />
      {strategy.sharedBy && (
        <div className="-mt-4 mb-4">
          <SharedBy sharedBy={strategy.sharedBy} prefs={prefs} />
        </div>
      )}
      <StrategyEditor
        strategyId={strategy.id}
        strategyName={strategy.name}
        status={strategy.status}
        library={strategy.library}
        initialDefinition={strategy.definition}
        initialRowVersion={strategy.rowVersion}
        instruments={instruments}
        optionUnderlyings={optionUnderlyings.map((u) => ({
          id: u.id,
          symbol: u.symbol,
          latestAsOf: u.latestAsOf,
        }))}
        accounts={accounts}
        timeZone={profile.timezone}
        baseCurrency={profile.baseCurrency}
        history={versionsCard}
      />
    </RowVersionProvider>
  );
}
