import 'server-only';
import { listenForExecutionChanges, type ExecutionListener } from '@tm/db';
import { serverEnv } from './env';
import { logger } from './log';

/**
 * Fans the database's execution change notices (ADR 0013) out to the open
 * Orders tabs of the user they belong to. One LISTEN connection per server
 * process, opened on first use; a notice carries only a user id, so each tab
 * re-reads its own data through the normal, tenant-scoped API.
 */

type Subscriber = () => void;

interface Hub {
  subscribers: Map<string, Set<Subscriber>>;
  listener?: Promise<ExecutionListener | undefined> | undefined;
}

const globalForHub = globalThis as unknown as { tmExecutionHub?: Hub };
const hub = (globalForHub.tmExecutionHub ??= { subscribers: new Map() });

function ensureListening() {
  hub.listener ??= listenForExecutionChanges(serverEnv().DATABASE_APP_URL, (userId) => {
    for (const notify of hub.subscribers.get(userId) ?? []) notify();
  }).catch((error: unknown) => {
    // Tabs fall back to their slow refresh; the next subscriber tries again.
    logger().warn({ reason: (error as Error).message }, 'Execution change listener failed');
    hub.listener = undefined;
    return undefined;
  });
}

export function subscribeToExecutionChanges(userId: string, notify: Subscriber): () => void {
  ensureListening();
  let set = hub.subscribers.get(userId);
  if (!set) hub.subscribers.set(userId, (set = new Set()));
  set.add(notify);
  return () => {
    set.delete(notify);
    if (set.size === 0) hub.subscribers.delete(userId);
  };
}
