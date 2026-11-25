import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configPath } from './paths';

/**
 * The companion's settings file. It holds the pairing token, so the folder is
 * private to the computer user (0700) and the file is too (0600). The token
 * is never printed back; status shows only its first characters.
 */
export const CompanionConfig = z.object({
  /** The Trading Magician site, e.g. https://web-staging-737c.up.railway.app */
  apiBase: z.url(),
  /** The pairing token (`tma_…`, scope research_sync). */
  token: z.string().startsWith('tma_'),
  /** The local Postgres port, chosen once at pairing. */
  pgPort: z.number().int().min(1024).max(65535),
  /** The local Postgres password, made at pairing; never leaves this computer. */
  pgPassword: z.string().min(24),
  pairedAt: z.string(),
});
export type CompanionConfig = z.infer<typeof CompanionConfig>;

export const DEFAULT_PG_PORT = 54_329;

export async function readConfig(home: string): Promise<CompanionConfig | null> {
  let raw: string;
  try {
    raw = await readFile(configPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return CompanionConfig.parse(JSON.parse(raw));
}

export async function writeConfig(home: string, config: CompanionConfig): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const path = configPath(home);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(CompanionConfig.parse(config), null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** A new settings file for a fresh pairing. Keeps the local database password if one exists. */
export function newConfig(
  input: { apiBase: string; token: string },
  existing: CompanionConfig | null,
  now = new Date(),
): CompanionConfig {
  return {
    apiBase: input.apiBase.replace(/\/+$/, ''),
    token: input.token.trim(),
    pgPort: existing?.pgPort ?? DEFAULT_PG_PORT,
    pgPassword: existing?.pgPassword ?? randomBytes(24).toString('base64url'),
    pairedAt: now.toISOString(),
  };
}

export const tokenHint = (token: string) => `${token.slice(0, 8)}…`;
