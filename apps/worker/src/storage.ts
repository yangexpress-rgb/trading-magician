import {
  expireAuditEvents,
  expireNotifications,
  notify,
  researchTablesInCore,
  sharedFeedOwner,
  storageBytes,
  sweepResearchStore,
  thinPositionSnapshots,
  withTenant,
  type Database,
  type ResearchStore,
} from '@tm/db';
import { nyDate } from '@tm/domain';
import type { Logger } from 'pino';

/**
 * Storage upkeep (ADR 0115, N331–N333): once a day the retention trims and
 * the Research Store's integrity sweep; every pass the 80% storage check on
 * each database's own volume (A3). Nothing here touches trading data a
 * running strategy reads.
 */

export const STORAGE_DEFAULTS = {
  /** Notifications are deleted after this many days. */
  notificationDays: 180,
  /** Audit events are deleted after this many days (the database refuses fewer than 365). */
  auditDays: 365,
  /** Position snapshots keep every row this long, then one a day. */
  intradaySnapshotDays: 30,
  /** Share of a volume at which the admin is told. */
  alertShare: 0.8,
} as const;

export interface StorageVolume {
  name: 'Core' | 'Research';
  db: Database;
  /** The volume's size in MB (CORE_VOLUME_MB / RESEARCH_VOLUME_MB). */
  volumeMb: number;
}

export interface StorageCheck {
  name: StorageVolume['name'];
  usedMb: number;
  volumeMb: number;
  share: number;
  alert: boolean;
}

/** Each database's size against its volume; past the alert share, the admin is told once a day. */
export async function checkStorage(options: {
  core: Database;
  volumes: readonly StorageVolume[];
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
  alertShare?: number;
}): Promise<StorageCheck[]> {
  const now = (options.now ?? (() => new Date()))();
  const alertShare = options.alertShare ?? STORAGE_DEFAULTS.alertShare;
  const out: StorageCheck[] = [];
  for (const v of options.volumes) {
    const usedMb = (await storageBytes(v.db)) / 1_048_576;
    const share = v.volumeMb > 0 ? usedMb / v.volumeMb : 0;
    const check = { name: v.name, usedMb, volumeMb: v.volumeMb, share, alert: share >= alertShare };
    out.push(check);
    if (!check.alert) continue;
    const pct = Math.round(share * 100);
    options.logger.warn(
      { store: v.name, usedMb: Math.round(usedMb), volumeMb: v.volumeMb, pct },
      'database storage past the alert level',
    );
    const owner = await options.core.transaction((tx) => sharedFeedOwner(tx));
    if (!owner) continue;
    await withTenant(options.core, { userId: owner }, (tx) =>
      notify(tx, {
        userId: owner,
        kind: 'storage_alert',
        title: `${v.name} database is ${pct}% full`,
        body:
          `The ${v.name} database uses ${Math.round(usedMb).toLocaleString('en-US')} MB of its ` +
          `${v.volumeMb.toLocaleString('en-US')} MB volume. ` +
          (v.name === 'Core'
            ? 'Trading needs this database: grow its volume in Railway before it fills.'
            : 'Trading does not use this database, but research jobs stop if it fills: grow its volume in Railway.'),
        resourceType: 'storage',
        dedupeKey: `storage:${v.name}:${nyDate(now)}`,
      }),
    );
  }
  return out;
}

export interface RetentionResult {
  notifications: number;
  auditEvents: number;
  positionSnapshots: number;
  purgedUserRows: number;
  orphanTrades: number;
}

/** The daily trims (ADR 0115). */
export async function runStorageRetention(options: {
  core: Database;
  research: ResearchStore;
  notificationDays?: number;
  auditDays?: number;
  intradaySnapshotDays?: number;
}): Promise<RetentionResult> {
  const notifications = await expireNotifications(
    options.core,
    options.notificationDays ?? STORAGE_DEFAULTS.notificationDays,
  );
  const auditEvents = await expireAuditEvents(
    options.core,
    options.auditDays ?? STORAGE_DEFAULTS.auditDays,
  );
  const positionSnapshots = await thinPositionSnapshots(
    options.core,
    options.intradaySnapshotDays ?? STORAGE_DEFAULTS.intradaySnapshotDays,
  );
  const sweep = await sweepResearchStore(options.core, options.research);
  return { notifications, auditEvents, positionSnapshots, ...sweep };
}

export interface StorageLoop {
  stop(): Promise<void>;
}

/** Checks storage every `everyMs` (default 15 minutes) and trims once a New York day. */
export function startStorageLoop(options: {
  core: Database;
  research: ResearchStore;
  volumes: readonly StorageVolume[];
  logger: Pick<Logger, 'info' | 'warn'>;
  everyMs?: number;
  now?: () => Date;
}): StorageLoop {
  const everyMs = options.everyMs ?? 15 * 60_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let trimmedOn = '';
  const shortError = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
  const pass = async () => {
    const now = (options.now ?? (() => new Date()))();
    // Each volume on its own: a Research outage never stops the Core check.
    for (const v of options.volumes) {
      await checkStorage({ core: options.core, volumes: [v], logger: options.logger }).catch(
        (e: unknown) =>
          options.logger.warn({ store: v.name, err: shortError(e) }, 'storage check failed'),
      );
    }
    if (trimmedOn !== nyDate(now)) {
      trimmedOn = nyDate(now);
      // The Window Contract's boundary (ADR 0115): with a Research Store of its
      // own, Core should hold no research rows once the move is cleared.
      if (options.research.separate) {
        const left = await researchTablesInCore(options.core).catch(() => []);
        if (left.length > 0)
          options.logger.warn(
            { tables: left },
            'research tables still hold rows in Core (expected until research:clear-core)',
          );
      }
      try {
        const r = await runStorageRetention({ core: options.core, research: options.research });
        options.logger.info(r, 'storage retention done');
      } catch (e) {
        options.logger.warn({ err: shortError(e) }, 'storage retention failed');
      }
    }
  };
  const loop = () => {
    if (stopped) return;
    running = pass().finally(() => {
      running = undefined;
      if (!stopped) timer = setTimeout(loop, everyMs);
    });
  };
  timer = setTimeout(loop, 30_000);
  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
