import { ModeBadge } from '@tm/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="mb-8 flex items-center justify-between">
        <Link href="/" className="font-semibold">
          Trading Magician
        </Link>
        <ModeBadge mode="paper" />
      </div>
      <article className="space-y-4 text-sm leading-6">{children}</article>
      <p className="mt-10 text-sm">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </main>
  );
}
