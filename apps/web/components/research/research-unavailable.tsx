import { ResearchUnavailableError } from '@tm/db';
import { Card } from '@tm/ui';

/**
 * The plain status a research page shows when the Research Store can't be
 * reached (ADR 0115). Trading never reads the Research Store, so it says so.
 */
export function ResearchUnavailable() {
  return (
    <Card>
      <div role="status" className="space-y-1">
        <h2 className="text-lg font-semibold">Research storage isn&rsquo;t reachable right now</h2>
        <p className="text-sm text-ink-muted">
          Research results are paused until it&rsquo;s back. Trading is unaffected: running
          strategies and orders keep working.
        </p>
      </div>
    </Card>
  );
}

/** Runs a research read; `undefined` when the Research Store is down, so the page can say so. */
export async function readResearch<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ResearchUnavailableError) return undefined;
    throw error;
  }
}
