/** How long the worker may go without a heartbeat before the system counts as down (ADR 0025). */
export const WORKER_STALE_SECONDS = 180;

export interface SystemHealth {
  status: 'ok' | 'degraded';
  database: 'ok' | 'unreachable';
  worker: 'ok' | 'stale' | 'never_seen';
  workerLastSeenSeconds: number | null;
}

/** For uptime checks: the database answers and the worker has beaten recently. */
export function systemHealth(
  beats: { service: string; beatAt: Date }[] | null,
  now: Date,
): SystemHealth {
  if (beats === null) {
    return {
      status: 'degraded',
      database: 'unreachable',
      worker: 'never_seen',
      workerLastSeenSeconds: null,
    };
  }
  const beat = beats.find((b) => b.service === 'worker');
  if (!beat) {
    return {
      status: 'degraded',
      database: 'ok',
      worker: 'never_seen',
      workerLastSeenSeconds: null,
    };
  }
  const age = Math.max(0, Math.round((now.getTime() - beat.beatAt.getTime()) / 1000));
  const fresh = age <= WORKER_STALE_SECONDS;
  return {
    status: fresh ? 'ok' : 'degraded',
    database: 'ok',
    worker: fresh ? 'ok' : 'stale',
    workerLastSeenSeconds: age,
  };
}
