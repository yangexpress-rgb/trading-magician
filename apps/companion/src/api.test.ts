import { describe, expect, it } from 'vitest';
import { CompanionApiError, CompanionClient } from './api';

type Call = { url: string; init: RequestInit };

function fakeFetch(reply: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { fn, calls };
}

const inst = (id: string) => ({
  id,
  symbol: `S${id}`,
  assetClass: 'equity',
  kind: 'stock',
  displayName: id,
  venue: 'XNYS',
  currency: 'USD',
});

describe('CompanionClient', () => {
  it('says hello with the pairing token', async () => {
    const f = fakeFetch(() =>
      Response.json({ connectionId: 'c1', seenAt: '2026-11-25T00:00:00.000Z', serverTime: 'x' }),
    );
    const client = new CompanionClient({
      apiBase: 'https://tm.example/',
      token: 'tma_t',
      fetch: f.fn,
    });
    const reply = await client.hello({ version: '0.1.0', platform: 'darwin-arm64' });
    expect(reply.connectionId).toBe('c1');
    expect(f.calls[0]!.url).toBe('https://tm.example/api/companion/v1/hello');
    expect(f.calls[0]!.init.method).toBe('POST');
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tma_t');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      version: '0.1.0',
      platform: 'darwin-arm64',
    });
  });

  it('follows instrument pages to the end', async () => {
    const f = fakeFetch(({ url }) =>
      url.includes('after=b')
        ? Response.json({ instruments: [inst('c')], next: null })
        : Response.json({ instruments: [inst('a'), inst('b')], next: 'b' }),
    );
    const client = new CompanionClient({
      apiBase: 'https://tm.example',
      token: 'tma_t',
      fetch: f.fn,
    });
    expect((await client.allInstruments()).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(f.calls).toHaveLength(2);
  });

  it('turns an unpaired token into a final error', async () => {
    const f = fakeFetch(() =>
      Response.json(
        { error: { code: 'connection_revoked', message: 'This companion was unpaired.' } },
        { status: 401 },
      ),
    );
    const client = new CompanionClient({
      apiBase: 'https://tm.example',
      token: 'tma_t',
      fetch: f.fn,
    });
    const error = await client.membership().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CompanionApiError);
    expect(error).toMatchObject({ code: 'connection_revoked', final: true });
  });

  it('passes the rate limit wait along and is not final', async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'rate_limited', message: 'Too many calls' } }),
          {
            status: 429,
            headers: { 'retry-after': '17' },
          },
        ),
    );
    const client = new CompanionClient({
      apiBase: 'https://tm.example',
      token: 'tma_t',
      fetch: f.fn,
    });
    const error = (await client.membership().catch((e: unknown) => e)) as CompanionApiError;
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 17, final: false });
  });

  it('reports the cloud being out of reach as offline', async () => {
    const fn = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = new CompanionClient({
      apiBase: 'https://tm.example',
      token: 'tma_t',
      fetch: fn,
    });
    await expect(client.membership()).rejects.toMatchObject({ code: 'offline', final: false });
  });

  it('refuses a reply it does not understand', async () => {
    const f = fakeFetch(() => Response.json({ periods: 'nope' }));
    const client = new CompanionClient({
      apiBase: 'https://tm.example',
      token: 'tma_t',
      fetch: f.fn,
    });
    await expect(client.membership()).rejects.toMatchObject({ code: 'bad_reply' });
  });
});
