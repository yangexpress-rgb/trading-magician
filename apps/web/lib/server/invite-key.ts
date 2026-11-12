import 'server-only';
import { inviteCodeKey } from '@tm/db';
import { serverEnv } from './env';

let cached: Buffer | undefined;

/**
 * The key that seals whole invite codes so the admin page can show them again
 * (N238, ADR 0085). Derived from BETTER_AUTH_SECRET, which only the web app
 * holds; changing that secret makes earlier codes show their first four only.
 */
export const inviteKey = (): Buffer => (cached ??= inviteCodeKey(serverEnv().BETTER_AUTH_SECRET));
