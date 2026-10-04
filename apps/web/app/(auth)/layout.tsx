import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main>
      <div className="card stack">
        <p className="muted">
          Trading Magician <span className="badge">Paper only</span>
        </p>
        {children}
      </div>
    </main>
  );
}
