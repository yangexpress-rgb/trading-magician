import {
  adminAlpacaFeeds,
  openCredential,
  withTenant,
  type CredentialKey,
  type Database,
} from '@tm/db';

/**
 * The Alpaca key behind the options recording (ADR 0047, fallback ADR 0050):
 * closes, the history rebuild and seed lookups. The worker's own
 * `OPTIONS_ALPACA_KEY_ID` / `OPTIONS_ALPACA_SECRET_KEY` win; without them it
 * uses the oldest platform admin's active Alpaca paper feed, so a one-person
 * install needs no second copy of the key. Read once at start: a changed feed
 * key takes effect when the worker restarts. The key stays in memory only.
 */
export interface OptionsAlpacaKey {
  keyId: string;
  secretKey: string;
  source: 'env' | 'admin_feed';
}

export async function resolveOptionsAlpacaKey(options: {
  db: Database;
  env: { keyId?: string | undefined; secretKey?: string | undefined };
  privateKey: CredentialKey | undefined;
  logger: { warn: (obj: object, msg: string) => void };
}): Promise<OptionsAlpacaKey | undefined> {
  const { keyId, secretKey } = options.env;
  if (keyId && secretKey) return { keyId, secretKey, source: 'env' };
  if (!options.privateKey) return undefined;
  let feeds: Awaited<ReturnType<typeof adminAlpacaFeeds>>;
  try {
    feeds = await adminAlpacaFeeds(options.db);
  } catch (e) {
    options.logger.warn({ err: { name: (e as Error).name } }, 'admin Alpaca feeds unreadable');
    return undefined;
  }
  for (const feed of feeds) {
    try {
      const opened = await withTenant(options.db, { userId: feed.userId }, (tx) =>
        openCredential(tx, {
          userId: feed.userId,
          id: feed.credentialId,
          privateKey: options.privateKey,
        }),
      );
      const id = opened.fields.keyId;
      const secret = opened.fields.secretKey;
      if (opened.provider === 'alpaca' && id && secret)
        return { keyId: id, secretKey: secret, source: 'admin_feed' };
    } catch (e) {
      options.logger.warn(
        { feedId: feed.feedId, err: { name: (e as Error).name } },
        "an admin's Alpaca feed key could not be opened",
      );
    }
  }
  return undefined;
}
