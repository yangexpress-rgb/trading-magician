import 'server-only';
import { aiKeySealKey } from '@tm/db';
import { serverEnv } from './env';

let cached: Buffer | undefined;

/**
 * The key that seals Ask AI agents' API keys (N274, ADR 0094). Derived from
 * BETTER_AUTH_SECRET, which only the web app holds; changing that secret means
 * each person enters their agent's key again.
 */
export const aiSealKey = (): Buffer => (cached ??= aiKeySealKey(serverEnv().BETTER_AUTH_SECRET));
