import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Trading Magician', template: '%s · Trading Magician' },
  description: 'Plan, test and run multi-asset trading strategies. Paper trading only.',
};

// Every page is rendered per request so the CSP nonce set in proxy.ts reaches
// Next.js's inline scripts.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
