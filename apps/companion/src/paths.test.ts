import { describe, expect, it } from 'vitest';
import { companionHome } from './paths';

describe('companionHome', () => {
  it('uses the usual per-user folder on each system', () => {
    expect(companionHome({}, 'darwin', '/Users/y')).toBe(
      '/Users/y/Library/Application Support/Trading Magician Companion',
    );
    expect(
      companionHome({ APPDATA: 'C:\\Users\\y\\AppData\\Roaming' }, 'win32', 'C:\\Users\\y'),
    ).toContain('Trading Magician Companion');
    expect(companionHome({}, 'linux', '/home/y')).toBe(
      '/home/y/.local/share/trading-magician-companion',
    );
    expect(companionHome({ XDG_DATA_HOME: '/data' }, 'linux', '/home/y')).toBe(
      '/data/trading-magician-companion',
    );
  });

  it('honours TM_COMPANION_HOME', () => {
    expect(companionHome({ TM_COMPANION_HOME: '/elsewhere' }, 'darwin', '/Users/y')).toBe(
      '/elsewhere',
    );
  });
});
