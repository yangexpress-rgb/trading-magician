import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Trading Magician', template: '%s · Trading Magician' },
  description: 'Plan, test and run multi-asset trading strategies. Paper trading only.',
};

// The data font (design v1.2 N133, ADR 0057): Inter, Latin subset, variable
// weight, bundled with the app and served from our own origin (no third-party
// request; SIL Open Font License, see fonts/Inter-OFL.txt). Only the data text
// role uses it, through --font-data; titles and labels stay on the system sans.
const inter = localFont({
  src: './fonts/inter-latin-wght.woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-inter',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
});

// Every page is rendered per request so the CSP nonce set in proxy.ts reaches
// Next.js's inline scripts.
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
