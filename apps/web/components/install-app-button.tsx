'use client';

import { Button, Dialog, InstallIcon } from '@tm/ui';
import { useEffect, useState } from 'react';

/** Chrome and Edge's install prompt event (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Browser = 'safari' | 'edge' | 'chrome' | 'other';

function detectBrowser(ua: string): Browser {
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

function runningAsApp(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: tabbed)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Sidebar "Install desktop app" (N252, ADR 0089). In Chrome and Edge it opens
 * the browser's own install prompt; elsewhere, or once that prompt is no
 * longer offered, it explains the menu steps. Hidden inside the installed app.
 */
export function InstallAppButton() {
  const [inApp, setInApp] = useState(true);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  const [help, setHelp] = useState(false);
  const [browser, setBrowser] = useState<Browser>('other');

  useEffect(() => {
    setInApp(runningAsApp());
    setBrowser(detectBrowser(navigator.userAgent));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setPrompt(null);
      setHelp(false);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (inApp) return null;

  const onClick = async () => {
    if (!prompt) {
      setHelp(true);
      return;
    }
    await prompt.prompt();
    // A prompt can be shown only once; Chrome offers a new one if it is dismissed.
    setPrompt(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void onClick()}
        className="inline-flex items-center gap-3 rounded-md px-3 py-2 text-left text-sm whitespace-nowrap text-ink-muted hover:bg-surface-2 hover:text-ink"
      >
        <InstallIcon />
        Install desktop app
      </button>
      <Dialog
        open={help}
        onClose={() => setHelp(false)}
        title="Install the desktop app"
        description="Trading Magician opens in its own window, with its own icon in the Dock or taskbar."
      >
        <InstallSteps browser={browser} />
        <p className="mt-3 text-sm text-ink-muted">
          Already installed? Open Trading Magician from the Dock, Launchpad or Start menu.
        </p>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => setHelp(false)}>Close</Button>
        </div>
      </Dialog>
    </>
  );
}

function InstallSteps({ browser }: { browser: Browser }) {
  const steps: Record<Browser, string> = {
    safari: 'In Safari on a Mac, choose File > Add to Dock, then click Add.',
    chrome:
      'In Chrome, click the install icon at the right end of the address bar, or open the ⋮ menu > Cast, save, and share > Install page as app.',
    edge: 'In Edge, open the ⋯ menu > Apps > Install this site as an app.',
    other:
      'Open the app in Chrome or Edge (Mac or Windows), or Safari on a Mac, to install it as a desktop app.',
  };
  return <p className="text-sm">{steps[browser]}</p>;
}
