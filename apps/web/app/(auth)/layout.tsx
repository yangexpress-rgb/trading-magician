import { ModeBadge } from '@tm/ui';
import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-16">
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex items-center justify-between">
          <span className="font-semibold">Trading Magician</span>
          <ModeBadge mode="paper" />
        </div>
        {children}
      </div>
    </main>
  );
}
