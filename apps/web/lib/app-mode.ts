/** Browser-only checks for the installed desktop app (ADR 0089). */

declare global {
  interface Window {
    /** Set by e2e tests to act as the installed app (no display-mode emulation there). */
    __tmAppMode?: boolean;
  }
}

/** True when this window is the installed app's window (not a browser tab). */
export function runningAsInstalledApp(): boolean {
  return (
    window.__tmAppMode === true ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: tabbed)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** True inside one of the tab host's frames. */
export function insideAppTab(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}
