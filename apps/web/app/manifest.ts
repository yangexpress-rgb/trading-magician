import type { MetadataRoute } from 'next';

/**
 * Web app manifest (N250, ADR 0089). Lets Chrome "Install" and Safari
 * "Add to Dock" open Trading Magician in its own window with its own name and
 * icon. There is no service worker and nothing is cached for offline use, so
 * prices and orders always come live from the server.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Trading Magician',
    short_name: 'Trading Magician',
    description: 'Plan, test and run multi-asset trading strategies. Paper trading only.',
    // Opens into the tab bar (N253); signed-out windows go to sign-in first.
    start_url: '/tabs',
    scope: '/',
    // Browsers that offer tabbed app windows show tabs, so links can open
    // beside the current page; the rest use a plain app window (N252).
    // 'tabbed' is newer than Next.js's manifest type.
    display_override: [
      'tabbed',
      'standalone',
    ] as unknown as MetadataRoute.Manifest['display_override'],
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#ffffff',
    icons: [
      { src: '/icons/v3/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/v3/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/v3/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
