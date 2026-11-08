import {
  adminFeedsOf,
  openCredential,
  withTenant,
  type CredentialKey,
  type Database,
} from '@tm/db';

/**
 * Credentials for the global event jobs (free data feeds brief v1 D6, ADR
 * 0058): the worker's own environment variable wins; without it, the oldest
 * platform admin's active feed of that provider (the fallback ADR 0050 set
 * for options data). Read once at start, kept in memory only.
 */
export async function adminCredentialField(o: {
  db: Database;
  provider: 'sec' | 'fmp' | 'finnhub';
  field: string;
  privateKey: CredentialKey | undefined;
  logger: { warn: (obj: object, msg: string) => void };
}): Promise<string | undefined> {
  if (!o.privateKey) return undefined;
  let feeds: Awaited<ReturnType<typeof adminFeedsOf>>;
  try {
    feeds = await adminFeedsOf(o.db, o.provider);
  } catch (e) {
    o.logger.warn(
      { provider: o.provider, err: { name: (e as Error).name } },
      'admin feeds unreadable',
    );
    return undefined;
  }
  for (const feed of feeds) {
    try {
      const opened = await withTenant(o.db, { userId: feed.userId }, (tx) =>
        openCredential(tx, {
          userId: feed.userId,
          id: feed.credentialId,
          privateKey: o.privateKey,
        }),
      );
      const value = opened.fields[o.field];
      if (opened.provider === o.provider && value) return value;
    } catch (e) {
      o.logger.warn(
        { feedId: feed.feedId, err: { name: (e as Error).name } },
        "an admin's feed credential could not be opened",
      );
    }
  }
  return undefined;
}
