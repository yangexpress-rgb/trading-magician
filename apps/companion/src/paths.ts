import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the companion keeps its files: its settings (with the pairing token)
 * and its local Postgres data. One folder per computer user, in the usual
 * place for each operating system. TM_COMPANION_HOME overrides it (tests, or a
 * person who wants the data on another disk).
 */
export function companionHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.TM_COMPANION_HOME?.trim();
  if (override) return override;
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Trading Magician Companion');
  }
  if (platform === 'win32') {
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Trading Magician Companion');
  }
  return join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'trading-magician-companion');
}

export const configPath = (home: string) => join(home, 'companion.json');
export const pgDataDir = (home: string) => join(home, 'research-store');
