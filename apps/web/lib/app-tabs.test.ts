import { describe, expect, it } from 'vitest';
import { MAX_TABS, opensNewTab, readStoredTabs, tabPath, tabTitle } from './app-tabs';

const ORIGIN = 'https://app.example';

describe('tabPath', () => {
  it('keeps in-app paths with query and hash', () => {
    expect(tabPath('/orders?status=open#x', ORIGIN)).toBe('/orders?status=open#x');
    expect(tabPath(`${ORIGIN}/research`, ORIGIN)).toBe('/research');
  });
  it('refuses other sites, the tab host and API routes', () => {
    expect(tabPath('https://evil.example/orders', ORIGIN)).toBeNull();
    expect(tabPath('//evil.example/x', ORIGIN)).toBeNull();
    expect(tabPath('/tabs', ORIGIN)).toBeNull();
    expect(tabPath('/tabs?open=/orders', ORIGIN)).toBeNull();
    expect(tabPath('/api/health', ORIGIN)).toBeNull();
    expect(tabPath('javascript:alert(1)', ORIGIN)).toBeNull();
  });
});

describe('tabTitle', () => {
  it('drops the app name suffix', () => {
    expect(tabTitle('Orders · Trading Magician')).toBe('Orders');
    expect(tabTitle('')).toBe('Trading Magician');
  });
});

describe('readStoredTabs', () => {
  it('restores valid tabs and drops bad ones', () => {
    const raw = JSON.stringify({
      urls: ['/orders', 'https://evil.example/', 7, '/research'],
      active: 1,
    });
    expect(readStoredTabs(raw, ORIGIN)).toEqual({ urls: ['/orders', '/research'], active: 1 });
  });
  it('falls back on bad input', () => {
    expect(readStoredTabs(null, ORIGIN)).toBeNull();
    expect(readStoredTabs('not json', ORIGIN)).toBeNull();
    expect(readStoredTabs(JSON.stringify({ urls: [] }), ORIGIN)).toBeNull();
    expect(readStoredTabs(JSON.stringify({ urls: ['/a'], active: 5 }), ORIGIN)).toEqual({
      urls: ['/a'],
      active: 0,
    });
  });
  it('keeps at most MAX_TABS', () => {
    const urls = Array.from({ length: MAX_TABS + 5 }, (_, i) => `/p${i}`);
    expect(readStoredTabs(JSON.stringify({ urls, active: 0 }), ORIGIN)?.urls).toHaveLength(
      MAX_TABS,
    );
  });
});

describe('opensNewTab', () => {
  const base = { metaKey: false, ctrlKey: false, button: 0, target: null };
  it('opens a tab on Cmd/Ctrl-click, middle-click or target=_blank', () => {
    expect(opensNewTab(base)).toBe(false);
    expect(opensNewTab({ ...base, metaKey: true })).toBe(true);
    expect(opensNewTab({ ...base, ctrlKey: true })).toBe(true);
    expect(opensNewTab({ ...base, button: 1 })).toBe(true);
    expect(opensNewTab({ ...base, target: '_blank' })).toBe(true);
  });
});
