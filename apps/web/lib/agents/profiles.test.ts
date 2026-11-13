import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  MUSE_CALLBACK,
  museConnectUrl,
  profileForClient,
  SCOPE_TEXT,
} from './profiles';

const TECHNICAL = /\b(mcp|oauth|tokens?|endpoints?|scopes?|redirects?)\b/i;

describe('agent profiles (N271)', () => {
  it('keeps technical words out of the plain layer', () => {
    for (const p of AGENT_PROFILES) {
      const plain = [
        p.displayName,
        p.plainLine,
        p.connectNote ?? '',
        ...(p.connect.kind === 'paste' ? p.connect.steps : []),
        p.connect.kind === 'key' ? p.connect.pasteLabel : '',
      ];
      for (const text of plain) expect(text, `${p.id}: ${text}`).not.toMatch(TECHNICAL);
    }
    for (const s of Object.values(SCOPE_TEXT)) {
      expect(s.label).not.toMatch(TECHNICAL);
      expect(s.detail).not.toMatch(TECHNICAL);
    }
    expect(AGENT_PROFILES.map((p) => p.displayName)).toContain('Another AI agent');
  });

  it("builds Muse's connect link from the app's own origin", () => {
    const url = new URL(museConnectUrl('https://tm.example.com/some/path'));
    expect(`${url.origin}${url.pathname}`).toBe('https://agent.meta.ai/connect/oauth');
    expect(url.searchParams.get('service')).toBe('trading-magician');
    const raw = url.searchParams.get('spec')!;
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const spec = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    expect(spec).toEqual({
      version: 1,
      credential: {
        // Muse refuses a spec whose name lacks the custom. prefix.
        name: 'custom.trading-magician',
        domains: ['tm.example.com'],
        oauth: {
          issuer_domain: 'tm.example.com',
          authorization_url: 'https://tm.example.com/oauth/authorize',
          token_url: 'https://tm.example.com/api/oauth/token',
          revoke_url: 'https://tm.example.com/api/oauth/revoke',
          registration_url: 'https://tm.example.com/api/oauth/register',
          redirect_uri: MUSE_CALLBACK,
          scope: 'read operate',
          token_endpoint_auth_method: 'none',
        },
      },
    });
  });

  it('attributes clients by callback host first, then by name', () => {
    const muse = profileForClient({ clientName: 'Claude-ish', redirectUris: [MUSE_CALLBACK] });
    expect(muse.id).toBe('muse');
    expect(
      profileForClient({ clientName: 'Claude', redirectUris: ['https://claude.ai/cb'] }).id,
    ).toBe('claude');
    expect(
      profileForClient({ clientName: 'Agent', redirectUris: ['https://evil.agent.meta.ai.x/cb'] })
        .id,
    ).toBe('other-mcp');
  });
});
