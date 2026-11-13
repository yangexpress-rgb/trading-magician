'use client';

import { useEffect } from 'react';
import { TABS_PATH } from '@/lib/app-tabs';
import { insideAppTab, runningAsInstalledApp } from '@/lib/app-mode';

/**
 * In the installed app's own window, moves the page into the tab bar
 * (N253, ADR 0089). Does nothing in a browser tab or inside a tab's frame.
 */
export function AppWindowRedirect() {
  useEffect(() => {
    if (insideAppTab() || !runningAsInstalledApp()) return;
    const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(`${TABS_PATH}?open=${encodeURIComponent(here)}`);
  }, []);
  return null;
}
