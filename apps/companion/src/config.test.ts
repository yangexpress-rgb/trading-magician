import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PG_PORT, newConfig, readConfig, tokenHint, writeConfig } from './config';
import { configPath } from './paths';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('companion settings', () => {
  it('writes a private file and reads it back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'tmc-'));
    const home = join(dir, 'home');
    expect(await readConfig(home)).toBeNull();
    const config = newConfig({ apiBase: 'https://tm.example/', token: ' tma_abc123 ' }, null);
    expect(config).toMatchObject({
      apiBase: 'https://tm.example',
      token: 'tma_abc123',
      pgPort: DEFAULT_PG_PORT,
    });
    await writeConfig(home, config);
    expect(await readConfig(home)).toEqual(config);
    if (process.platform !== 'win32') {
      expect((await stat(configPath(home))).mode & 0o777).toBe(0o600);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps the local database password when pairing again', () => {
    const first = newConfig({ apiBase: 'https://a.example', token: 'tma_one' }, null);
    const again = newConfig({ apiBase: 'https://a.example', token: 'tma_two' }, first);
    expect(again.pgPassword).toBe(first.pgPassword);
    expect(again.token).toBe('tma_two');
  });

  it('shows only the start of the token', () => {
    expect(tokenHint('tma_abcdefghijklmnop')).toBe('tma_abcd…');
  });
});
