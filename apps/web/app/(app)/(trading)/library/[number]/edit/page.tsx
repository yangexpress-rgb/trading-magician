import {
  getLibraryEntry,
  listConventionVersions,
  listLibraryNames,
  listLinkableStrategies,
  withTenant,
} from '@tm/db';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { LibraryEntryDto } from '@tm/contracts';
import { LibraryEntryForm } from '@/components/library/entry-form';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

type Params = { number: string };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { number } = await params;
  return { title: `Edit ${decodeURIComponent(number).toUpperCase()} · Theory Library` };
}

export default async function EditLibraryEntryPage({ params }: { params: Promise<Params> }) {
  const tenant = await requireTenant();
  const { number } = await params;
  const data = await withTenant(appDb(), tenant, async (tx) => {
    const entry = await getLibraryEntry(tx, tenant.userId, decodeURIComponent(number));
    if (!entry) return null;
    return {
      entry,
      versions: await listConventionVersions(tx),
      names: await listLibraryNames(tx),
      strategies: await listLinkableStrategies(tx),
    };
  });
  if (!data) notFound();
  const { entry, versions, names, strategies } = data;
  // A former number opens the entry under its current number (ADR 0055).
  if (entry.registrationNumber !== decodeURIComponent(number)) {
    redirect(`/library/${entry.registrationNumber}/edit`);
  }
  const issuedUnder = versions.find((v) => v.label === entry.conventionVersion);
  if (!issuedUnder) notFound();
  // The DTO carries dates as strings; the form only reads plain fields.
  const dto = JSON.parse(JSON.stringify(entry)) as LibraryEntryDto;
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/library">Theory Library</Link> ›{' '}
        <Link href={`/library/${entry.registrationNumber}`}>{entry.registrationNumber}</Link>
      </nav>
      <PageHeader
        title={`Edit ${entry.registrationNumber}`}
        description="Every field can change except the registration number and the convention version that issued it. Each edit needs a change note."
      />
      <div className="max-w-4xl">
        <LibraryEntryForm
          mode="edit"
          tables={issuedUnder.tables}
          conventionLabel={issuedUnder.label}
          existingNames={names}
          strategies={strategies}
          entry={dto}
        />
      </div>
    </>
  );
}
