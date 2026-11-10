import { listShares, withTenant } from '@tm/db';
import { formatDateTime } from '@tm/domain';
import { Badge, EmptyState, PageHeader, Table, Td, Th } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AnswerCheckAll, AnswerCheckbox, BulkAnswer, type PendingShare } from './bulk-answer';
import { SHARE_KIND_LABELS, SHARE_STATUS_LABELS } from '@/lib/share-text';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { TradingStrategyNav } from '@/components/trading/trading-strategy-nav';

export const metadata: Metadata = { title: 'Sharing' };

type SearchParams = Record<string, string | string[] | undefined>;

/** Strategies shared with you, and the ones you shared (ADR 0056). */
export default async function SharingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const raw = await searchParams;
  const box = raw.box === 'sent' ? 'sent' : 'received';
  const items = await withTenant(appDb(), tenant, (tx) => listShares(tx, tenant.userId, { box }));
  const pending = items.filter((s) => s.status === 'pending').length;
  // What the recipient can still answer, for the tick boxes (N155).
  const answerable: PendingShare[] =
    box === 'received'
      ? items
          .filter((s) => s.status === 'pending')
          .map((s) => ({ id: s.id, label: `${s.sourceNumber} ${s.sourceName}` }))
      : [];

  return (
    <>
      <PageHeader
        title="Trading Strategy"
        description="Theories and strategies other members shared with you, and the ones you shared. Accepting makes your own copy with a new number; nothing changes for the sender."
      />
      <TradingStrategyNav />
      <nav aria-label="Sharing" className="mb-4 flex gap-2 border-b border-line">
        {(['received', 'sent'] as const).map((b) => (
          <Link
            key={b}
            href={b === 'received' ? '/sharing' : '/sharing?box=sent'}
            aria-current={box === b ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              box === b
                ? 'border-accent font-semibold text-ink'
                : 'border-transparent text-ink-muted'
            }`}
          >
            {b === 'received' ? 'Shared with me' : 'Shared by me'}
          </Link>
        ))}
      </nav>

      {items.length === 0 ? (
        <EmptyState
          title={
            box === 'received' ? 'Nothing shared with you yet' : 'You haven’t shared anything yet'
          }
        >
          {box === 'received'
            ? 'When a member shares a theory or strategy with you, it shows here for you to accept or decline.'
            : 'Use Share on a Library theory or a Strategy Lab strategy to send someone a copy.'}
        </EmptyState>
      ) : (
        <>
          {box === 'received' && pending > 0 && (
            <p className="mb-2 text-sm" aria-live="polite">
              {pending === 1 ? '1 share is' : `${pending} shares are`} waiting for your answer.
            </p>
          )}
          <BulkAnswer pending={answerable}>
            <Table label={box === 'received' ? 'Shared with me' : 'Shared by me'}>
              <thead>
                <tr>
                  {box === 'received' && (
                    <Th>
                      <AnswerCheckAll pending={answerable} />
                    </Th>
                  )}
                  <Th>Theory or strategy</Th>
                  <Th>{box === 'received' ? 'From' : 'To'}</Th>
                  <Th>Kind</Th>
                  <Th>Status</Th>
                  <Th>Shared ({prefs.timeZone})</Th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    {box === 'received' && (
                      <Td>
                        {s.status === 'pending' && (
                          <AnswerCheckbox
                            share={{ id: s.id, label: `${s.sourceNumber} ${s.sourceName}` }}
                          />
                        )}
                      </Td>
                    )}
                    <Td>
                      <Link href={`/sharing/${s.id}`} className="font-medium">
                        <span className="font-mono">{s.sourceNumber}</span> {s.sourceName}
                      </Link>
                      {s.note && <p className="mt-0.5 text-xs text-ink-muted">“{s.note}”</p>}
                    </Td>
                    <Td>
                      {box === 'received' ? s.sender.label : s.recipient.label}
                      {box === 'received' && s.sender.isAdmin && (
                        <Badge tone="warn" icon={false} className="ml-2">
                          Admin
                        </Badge>
                      )}
                    </Td>
                    <Td className="text-xs">{SHARE_KIND_LABELS[s.kind]}</Td>
                    <Td>
                      <Badge tone={SHARE_STATUS_LABELS[s.status].tone}>
                        {SHARE_STATUS_LABELS[s.status].label}
                      </Badge>
                      {s.result?.number && (
                        <p className="mt-0.5 font-mono text-xs">
                          Copy: <Link href={`/library/${s.result.number}`}>{s.result.number}</Link>
                        </p>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-content">
                      {formatDateTime(s.createdAt, prefs)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </BulkAnswer>
        </>
      )}
    </>
  );
}
