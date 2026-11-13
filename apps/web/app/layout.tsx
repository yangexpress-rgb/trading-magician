import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Trading Magician', template: '%s · Trading Magician' },
  description: 'Plan, test and run multi-asset trading strategies. Paper trading only.',
  applicationName: 'Trading Magician',
  // Safari "Add to Dock" / "Add to Home Screen" name and window (N250).
  appleWebApp: { capable: true, title: 'Trading Magician', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#121722' },
  ],
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
