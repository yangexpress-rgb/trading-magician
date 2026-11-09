import { getCurrentConvention, listLibraryNames, listLinkableStrategies, withTenant } from '@tm/db';
import { PageHeader } from '@tm/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { LibraryEntryForm } from '@/components/library/entry-form';
import { appDb } from '@/lib/server/db';
import { requireTenant } from '@/lib/server/session';

export const metadata: Metadata = { title: 'Register a theory · Theory Library' };

export default async function RegisterLibraryEntryPage() {
  const tenant = await requireTenant();
  const { convention, names, strategies } = await withTenant(appDb(), tenant, async (tx) => ({
    convention: await getCurrentConvention(tx),
    names: await listLibraryNames(tx),
    strategies: await listLinkableStrategies(tx),
  }));
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-sm">
        <Link href="/library">Theory Library</Link>
      </nav>
      <PageHeader
        title="Register a theory"
        description="Every entry answers the same questions: what it is, what it trades, when it enters and exits, how often and for how long, who used it before and what the evidence shows."
      />
      <div className="max-w-4xl">
        <LibraryEntryForm
          mode="register"
          tables={convention.tables}
          conventionLabel={convention.label}
          existingNames={names}
          strategies={strategies}
        />
      </div>
    </>
  );
}
