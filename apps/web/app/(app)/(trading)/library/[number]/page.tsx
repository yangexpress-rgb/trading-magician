import { getLibraryEntry, withTenant } from '@tm/db';
import {
  CATEGORY_LABELS,
  DATA_NEED_LABELS,
  DIRECTION_LABELS,
  EVIDENCE_LABELS,
  formatDateTime,
  formatDuration,
  MATURITY_LABELS,
  REBALANCE_LABELS,
  SIZING_LABELS,
  STOP_LABELS,
  UNIVERSE_LABELS,
  type DisplayPreferences,
} from '@tm/domain';
import { Badge, buttonClasses, Card } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Markdown } from '@/components/library/markdown';
import { RetireButton } from '@/components/library/retire-button';
import { ShareButton } from '@/components/sharing/share-button';
import { SharedBy } from '@/components/sharing/shared-by';
import { isAdmin } from '@/lib/server/admin';
import {
  ACTOR_LABELS,
  BUILT_LABELS,
  FIELD_LABELS,
  methodText,
  NOT_SPECIFIED,
} from '@/lib/library-text';
import { appDb } from '@/lib/server/db';
import { getProfile } from '@/lib/server/profile';
import { requireTenant } from '@/lib/server/session';

type Params = { number: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { number } = await params;
  return { title: `${decodeURIComponent(number).toUpperCase()} · Theory Library` };
}

/** One Strategy Library entry: the full standard record (ADR 0051). */
export default async function LibraryEntryPage({ params }: { params: Promise<Params> }) {
  const tenant = await requireTenant();
  const profile = await getProfile(tenant);
  const prefs: DisplayPreferences = { timeZone: profile.timezone, locale: profile.locale };
  const { number } = await params;
  const e = await withTenant(appDb(), tenant, (tx) =>
    getLibraryEntry(tx, tenant.userId, decodeURIComponent(number)),
  );
  if (!e) notFound();
  // A former number (ADR 0055) redirects to the entry's current, canonical URL.
  if (decodeURIComponent(number) !== e.registrationNumber) {
    redirect(`/library/${e.registrationNumber}`);
  }
  const retired = e.status === 'retired';

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/library">Theory Library</Link>
      </nav>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-sm text-ink-muted">{e.registrationNumber}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">{e.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {retired && <Badge tone="warn">Retired</Badge>}
            <Badge tone={e.builtStatus === 'built' ? 'ok' : 'neutral'}>
              {BUILT_LABELS[e.builtStatus]}
            </Badge>
            <Badge tone="info" icon={false}>
              {CATEGORY_LABELS[e.category]}
            </Badge>
            <Badge tone="neutral" icon={false}>
              {MATURITY_LABELS[e.maturity]}
            </Badge>
            <Badge tone="neutral" icon={false}>
              {e.direction ? DIRECTION_LABELS[e.direction] : `Direction: ${NOT_SPECIFIED}`}
            </Badge>
            {e.tags.map((t) => (
              <span key={t} className="text-xs text-ink-muted">
                #{t}
              </span>
            ))}
          </div>
          <p className="mt-2 text-sm text-ink-muted">
            {[
              e.letters.recordType?.meaning ?? e.recordTypeCode,
              e.letters.assetClass?.meaning ?? e.assetClassCode,
              e.letters.timeframe?.meaning ?? e.timeframeCode,
            ].join(' · ')}{' '}
            — letters read under convention {e.conventionVersion}, which issued this number.
          </p>
          <SharedBy sharedBy={e.sharedBy} copiedFrom={e.copiedFrom} prefs={prefs} />
        </div>
        <div className="flex gap-2">
          <Link
            href={`/library/${e.registrationNumber}/edit`}
            className={buttonClasses('secondary')}
          >
            Edit
          </Link>
          {!retired && (
            <ShareButton
              source={{ kind: 'library', number: e.registrationNumber }}
              label={`${e.registrationNumber} ${e.name}`}
              isAdmin={await isAdmin()}
            />
          )}
          {!retired && (
            <RetireButton registrationNumber={e.registrationNumber} rowVersion={e.rowVersion} />
          )}
        </div>
      </div>

      {retired && (
        <p
          role="status"
          className="mb-4 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm"
        >
          Retired{e.retiredAt ? ` ${formatDateTime(e.retiredAt, prefs)}` : ''}: {e.retiredReason}.
          It keeps its number; a theory that returns is registered again under a new number.
        </p>
      )}

      <p className="mb-6 max-w-prose text-base leading-relaxed text-content">
        {e.shortDescription}
      </p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-4 text-lg font-semibold">How it works</h2>
            <Markdown source={e.longDescription} />
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Trading rules</h2>
            <Field label="Assets">{e.assets}</Field>
            <Field label="Entry">
              <Markdown source={e.entry} />
            </Field>
            <Field label="Exit">
              <Markdown source={e.exit} />
            </Field>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Field label="Frequency (how often it opens positions)">
                {formatDuration(e.frequency)}
              </Field>
              <Field label="Turnaround time (typical holding period)">
                {formatDuration(e.turnaround)}
              </Field>
            </div>
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Parameters</h2>
            {e.parameters.length === 0 ? (
              <Muted>{NOT_SPECIFIED}.</Muted>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-muted">
                    <th className="pb-1 font-semibold">Parameter</th>
                    <th className="pb-1 font-semibold">Value</th>
                    <th className="pb-1 font-semibold">Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {e.parameters.map((p, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="py-1 pr-3 text-content">{p.name}</td>
                      <td className="py-1 pr-3 text-content">{p.value}</td>
                      <td className="py-1">
                        {p.unit ?? <span className="text-ink-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Risk &amp; sizing</h2>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Field label="Position sizing">
                {methodText(
                  e.positionSizing,
                  e.positionSizing ? SIZING_LABELS[e.positionSizing.method] : undefined,
                )}
              </Field>
              <Field label="Stop loss">
                {methodText(e.stopLoss, e.stopLoss ? STOP_LABELS[e.stopLoss.method] : undefined)}
              </Field>
            </div>
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Operations</h2>
            <div className="grid gap-x-6 sm:grid-cols-2">
              <Field label="Rebalance schedule">
                {methodText(
                  e.rebalanceSchedule,
                  e.rebalanceSchedule ? REBALANCE_LABELS[e.rebalanceSchedule.schedule] : undefined,
                )}
              </Field>
              <Field label="Universe">
                {methodText(e.universe, e.universe ? UNIVERSE_LABELS[e.universe.kind] : undefined)}
              </Field>
            </div>
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Evidence &amp; maturity</h2>
            <Field label="Maturity">{MATURITY_LABELS[e.maturity]}</Field>
            <Field label="Key risks">
              {e.keyRisks ? <Markdown source={e.keyRisks} /> : <Muted>{NOT_SPECIFIED}.</Muted>}
            </Field>
            <Field label="Used by">
              {e.usedBy.length === 0 ? (
                <p>No known prior use recorded.</p>
              ) : (
                <ul className="space-y-2">
                  {e.usedBy.map((u, i) => (
                    <li key={i}>
                      <span className="font-medium">{u.who}</span>{' '}
                      <Badge tone="neutral" icon={false}>
                        {EVIDENCE_LABELS[u.evidence]}
                      </Badge>
                      <p>{u.what}</p>
                      <p className="text-xs text-ink-muted">Source: {u.source}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <Field label="Track record">
              {e.trackRecord ? <Markdown source={e.trackRecord} /> : <Muted>None recorded.</Muted>}
            </Field>
            <Field label="Back test summary">
              {e.backtestSummary ?? <Muted>None recorded.</Muted>}
            </Field>
            <Field label="Sources">
              {e.sources.length === 0 ? (
                <Muted>None recorded.</Muted>
              ) : (
                <ul className="list-disc space-y-1 pl-5">
                  {e.sources.map((s, i) => (
                    <li key={i}>
                      {s.url ? (
                        <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">
                          {s.title}
                        </a>
                      ) : (
                        <span className="font-medium">{s.title}</span>
                      )}
                      {s.citation && <span className="text-ink-muted"> — {s.citation}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Strategy Lab</h2>
            <BuiltLink entry={e} />
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Data needs</h2>
            {e.dataNeeds.length === 0 ? (
              <Muted>{NOT_SPECIFIED}.</Muted>
            ) : (
              <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Data needs">
                {e.dataNeeds.map((d) => (
                  <li key={d}>
                    <Badge tone="neutral" icon={false}>
                      {DATA_NEED_LABELS[d]}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <Field label="Data requirements">
              {e.dataRequirements ?? <Muted>None recorded.</Muted>}
            </Field>
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Related entries</h2>
            {e.relatedEntries.length === 0 ? (
              <Muted>None.</Muted>
            ) : (
              <ul className="space-y-1 text-sm text-content">
                {e.relatedEntries.map((r) => (
                  <li key={r.registrationNumber}>
                    <Link href={`/library/${r.registrationNumber}`} className="font-mono">
                      {r.registrationNumber}
                    </Link>{' '}
                    {r.name}
                    {r.status === 'retired' && <span className="text-ink-muted"> (retired)</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <h2 className="mb-4 text-lg font-semibold">Record</h2>
            <dl className="space-y-1 text-sm">
              <div>
                <dt className="inline text-ink-muted">Registered by </dt>
                <dd className="inline text-content">
                  {ACTOR_LABELS[e.registeredBy]}, {formatDateTime(e.registeredAt, prefs)}
                </dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">Last changed by </dt>
                <dd className="inline text-content">
                  {ACTOR_LABELS[e.updatedBy]}, {formatDateTime(e.updatedAt, prefs)}
                </dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">Convention </dt>
                <dd className="inline text-content">{e.conventionVersion}</dd>
              </div>
            </dl>
            <h3 className="mt-4 mb-2 text-sm font-semibold">History</h3>
            {e.revisions.length === 0 ? (
              <Muted>No changes since registration.</Muted>
            ) : (
              <ol className="space-y-2 text-sm text-content">
                {e.revisions.map((r, i) => (
                  <li key={i}>
                    <p>
                      <span className="font-medium">
                        {r.action === 'retire'
                          ? 'Retired'
                          : r.action === 'create'
                            ? 'Created'
                            : r.editedBy === 'system'
                              ? 'Updated'
                              : 'Edited'}
                      </span>{' '}
                      by {ACTOR_LABELS[r.editedBy]}, {formatDateTime(r.editedAt, prefs)}
                    </p>
                    <p>“{r.note}”</p>
                    {r.action === 'edit' && (
                      <p className="text-xs text-ink-muted">
                        Changed: {r.changedFields.map((f) => FIELD_LABELS[f] ?? f).join(', ')}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-5 last:mb-0">
      {/* Label: small, muted, sentence case. Value: reading text at body size (N134). */}
      <h3 className="mb-1 text-sm font-medium text-ink-muted">{label}</h3>
      <div className="text-base text-prose">{children}</div>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-base text-ink-muted">{children}</p>;
}

function BuiltLink({ entry }: { entry: NonNullable<Awaited<ReturnType<typeof getLibraryEntry>>> }) {
  const b = entry.builtStrategy;
  return (
    <Field label="Built strategy">
      {!b ? (
        <Muted>Not built.</Muted>
      ) : b.visibility === 'yours' ? (
        <p>
          <Link href={`/strategy-lab/${b.id}`}>{b.name}</Link>
          {b.archived && <span className="text-ink-muted"> (archived)</span>}
        </p>
      ) : b.visibility === 'yours_deleted' ? (
        <Muted>Linked to a strategy you have since deleted.</Muted>
      ) : (
        <Muted>Built in another member’s Strategy Lab.</Muted>
      )}
    </Field>
  );
}
