import { getShare, inArray, schema, withTenant } from '@tm/db';
import {
  CATEGORY_LABELS,
  collectInstrumentUses,
  DIRECTION_LABELS,
  formatDateTime,
  type LibraryCategory,
  type LibraryDirection,
  type LibraryMaturity,
  MATURITY_LABELS,
  parseDefinition,
} from '@tm/domain';
import { Badge, Card } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Markdown } from '@/components/library/markdown';
import { SHARE_KIND_LABELS, SHARE_STATUS_LABELS } from '@/lib/share-text';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';
import { ShareActions } from './share-actions';

export const metadata: Metadata = { title: 'Shared theory or strategy' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One share: what was sent, as it was when shared, and the answer (ADR 0056). */
export default async function SharePage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  if (!UUID.test(shareId)) notFound();
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const prefs = { timeZone: profile.timezone, locale: profile.locale };
  const loaded = await withTenant(appDb(), tenant, async (tx) => {
    const share = await getShare(tx, tenant.userId, shareId);
    if (!share?.snapshot.strategy) return { share, symbols: [] as string[] };
    let ids: string[] = [];
    try {
      ids = [
        ...new Set(
          collectInstrumentUses(parseDefinition(share.snapshot.strategy.definition)).map(
            (u) => u.instrumentId,
          ),
        ),
      ];
    } catch {
      ids = [];
    }
    const rows = ids.length
      ? await tx
          .select({ symbol: schema.instruments.symbol })
          .from(schema.instruments)
          .where(inArray(schema.instruments.id, ids))
      : [];
    return { share, symbols: rows.map((r) => r.symbol).sort() };
  });
  const { share, symbols } = loaded;
  if (!share) notFound();
  const r = share.snapshot.record;
  const s = share.snapshot.strategy;
  const status = SHARE_STATUS_LABELS[share.status];
  const recipient = share.role === 'recipient';

  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={recipient ? '/sharing' : '/sharing?box=sent'}>← Sharing</Link>
      </p>
      <div className="mb-6">
        <p className="font-mono text-sm text-ink-muted">{share.sourceNumber}</p>
        <h1 className="text-2xl font-semibold tracking-tight">{share.sourceName}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={status.tone}>{status.label}</Badge>
          <Badge tone="neutral" icon={false}>
            {SHARE_KIND_LABELS[share.kind]}
          </Badge>
          <span>
            {recipient ? (
              <>
                Shared by <strong>{share.sender.label}</strong>
              </>
            ) : (
              <>
                Shared with <strong>{share.recipient.label}</strong>
              </>
            )}{' '}
            on {formatDateTime(share.createdAt, prefs)}
          </span>
          {recipient && share.sender.isAdmin && (
            <Badge tone="warn" icon={false}>
              Admin
            </Badge>
          )}
        </div>
        {share.note && (
          <blockquote className="mt-3 border-l-4 border-line pl-3 text-sm">{share.note}</blockquote>
        )}
      </div>

      <Card className="mb-6 space-y-3">
        {share.status === 'pending' && (
          <>
            <p className="text-sm">
              {recipient
                ? share.kind === 'lab'
                  ? 'Accepting adds a copy of this strategy to your Strategy Lab, with its own new Library number. Its order legs move to your paper account. Back tests, orders and run history are not part of it.'
                  : 'Accepting adds a copy of this theory to the Library, registered by you with its own new number.'
                : `Waiting for an answer. It expires on ${formatDateTime(share.expiresAt, prefs, { dateStyle: 'medium' })} if nobody answers.`}
            </p>
            <ShareActions id={share.id} role={share.role} />
          </>
        )}
        {share.status === 'accepted' && share.result?.number && (
          <p className="text-sm">
            {recipient ? 'Your copy is ' : 'Their copy is '}
            <Link href={`/library/${share.result.number}`} className="font-mono">
              {share.result.number}
            </Link>
            {recipient && share.result.strategyId && (
              <>
                {' '}
                —{' '}
                <Link href={`/strategy-lab/${share.result.strategyId}`}>
                  open it in Strategy Lab
                </Link>
              </>
            )}
            .
          </p>
        )}
        {share.status !== 'pending' && share.status !== 'accepted' && (
          <p className="text-sm text-ink-muted">
            This share is closed: {status.label.toLowerCase()}.
          </p>
        )}
      </Card>

      <h2 className="mb-3 text-lg font-semibold">What was shared</h2>
      <p className="mb-4 text-sm text-ink-muted">
        As it was when shared; later changes by the sender are not part of it.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {s && (
          <Card className="space-y-2 lg:col-span-2">
            <h3 className="font-semibold">Strategy</h3>
            <Field label="Name">{s.name}</Field>
            {s.description && <Field label="Description">{s.description}</Field>}
            <Field label="Instruments">{symbols.length ? symbols.join(', ') : '—'}</Field>
            {s.tags.length > 0 && <Field label="Tags">{s.tags.join(', ')}</Field>}
          </Card>
        )}
        <Card className="space-y-2">
          <h3 className="font-semibold">Library theory</h3>
          <Field label="Name">{r.name}</Field>
          <Field label="Category">
            {CATEGORY_LABELS[r.category as LibraryCategory] ?? r.category}
          </Field>
          <Field label="Direction">
            {r.direction ? DIRECTION_LABELS[r.direction as LibraryDirection] : 'Not specified'}
          </Field>
          <Field label="Maturity">
            {MATURITY_LABELS[(r.maturity ?? 'researched') as LibraryMaturity]}
          </Field>
          <Field label="Assets">{r.assets}</Field>
          <Field label="Summary">{r.shortDescription}</Field>
        </Card>
        <Card className="space-y-3">
          <Prose label="Entry" source={r.entry} />
          <Prose label="Exit" source={r.exit} />
        </Card>
        <Card className="space-y-3 lg:col-span-2">
          <Prose label="Description" source={r.longDescription} />
          {r.keyRisks && <Prose label="Key risks" source={r.keyRisks} />}
        </Card>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="text-sm">
      <span className="text-ink-muted">{label}: </span>
      {children}
    </div>
  );
}

function Prose({ label, source }: { label: string; source: string }) {
  return (
    <div>
      <h4 className="mb-1 text-sm font-semibold">{label}</h4>
      <Markdown source={source} />
    </div>
  );
}
